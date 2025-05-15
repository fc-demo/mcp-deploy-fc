import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import loadComponent from '@serverless-devs/load-component';
import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import fs from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'yaml';
import { Logger, logger } from './logger';
import sTemplate from './template.yaml';

async function runCommand(shell: string[], options?: SpawnOptionsWithoutStdio) {
  return await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      logger.log(`run command: ${shell.join(' ')}`);

      const process = spawn(shell[0], shell.slice(1), options);
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Command failed with exit code ${code}\nStdout: ${stdout}\n\nStderr: ${stderr}\n\n`
            )
          );
        } else {
          resolve({ stdout, stderr });
        }
      });
    }
  );
}

function parseCommand(command: string) {
  return command.split(' ');
}

async function sConfig() {
  const {
    ALIBABA_CLOUD_ACCESS_KEY_ID,
    ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    ALIBABA_CLOUD_SECURITY_TOKEN,
    FC_ACCOUNT_ID,

    ALIYUN_ACCESS_KEY_ID,
    ALIYUN_ACCESS_KEY_SECRET,
    ALIYUN_ACCOUNT_ID,
  } = process.env;

  const accountID = ALIYUN_ACCOUNT_ID || FC_ACCOUNT_ID;
  const accessKeyID = ALIYUN_ACCESS_KEY_ID || ALIBABA_CLOUD_ACCESS_KEY_ID;
  const accessKeySecret = ALIYUN_ACCESS_KEY_ID
    ? ALIYUN_ACCESS_KEY_SECRET
    : ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  const securityToken = ALIYUN_ACCESS_KEY_ID
    ? undefined
    : ALIBABA_CLOUD_SECURITY_TOKEN;

  if (!accessKeyID || !accessKeySecret || !accountID) {
    throw new Error(
      'ALIYUN_ACCOUNT_ID, ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET or function role is not set'
    );
  }

  return {
    accountID,
    accessKeyID,
    accessKeySecret,
    securityToken,
  };
}

async function runS(command: string, yamlPath: string) {
  const config = await sConfig();
  const logger = new Logger({ silent: true });

  const content = fs.readFileSync(yamlPath, 'utf8');
  const yamlObject = yaml.parse(content);

  const results: Record<string, any> = {};

  for (const [resourceKey, resource] of Object.entries<any>(
    yamlObject.resources
  )) {
    logger.log('s', command, resource?.component);

    const component = await loadComponent(resource?.component, {
      logger,
    });

    const result = await component[command]({
      props: resource?.props,
      name: yamlObject.name,
      args: ['--silent', '-t', yamlPath, '-y'],
      yaml: { path: yamlPath },
      cwd: path.dirname(yamlPath),
      resource: {
        name: resourceKey,
        component: resource?.component,
        access: 'default',
      },
      getCredential: async () => ({
        AccountID: config.accountID,
        AccessKeyID: config.accessKeyID,
        AccessKeySecret: config.accessKeySecret,
        SecurityToken: config.securityToken,
      }),
    });

    results[resourceKey] = result;
  }

  return results;
}

async function sDeploy(yamlPath: string) {
  return runS('deploy', yamlPath);
}

async function sRemove(yamlPath: string) {
  return runS('remove', yamlPath);
}

export async function deployCodeToFc(params: {
  functionName?: string;
  region?: string;
  code: { filename: string; content: string }[];
  port?: number;
  description?: string;
  environmentVariables?: Record<string, string>;
  timeout: number;
  installDependenciesCommand?: string[];
  startCommand: string[];
}): Promise<CallToolResult> {
  const {
    functionName: _fname = `mcp-deploy-fc-${uuidv4()}`,
    region = 'cn-hangzhou',
    code,
    description,
    environmentVariables,
    timeout,
    installDependenciesCommand,
    startCommand,
    port,
  } = params;
  logger.log(params);

  const functionName = _fname.startsWith('mcp-deploy-fc-')
    ? _fname
    : `mcp-deploy-fc-${_fname}`;

  const tempDir = path.join('/tmp', uuidv4());
  const codeDir = path.join(tempDir, 'code');

  fs.mkdirSync(codeDir, { recursive: true });

  try {
    for (const file of code) {
      const filePath = path.join(codeDir, file.filename);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content);
    }

    if (installDependenciesCommand && installDependenciesCommand.length > 0) {
      await runCommand(
        parseCommand(
          'pip3 config set https://global.index-url mirrors.aliyun.com/pypi/simple/'
        )
      );
      await runCommand(
        parseCommand('npm config set registry https://registry.npmmirror.com')
      );

      await runCommand(installDependenciesCommand, {
        cwd: codeDir,
      });
    }

    const syaml = JSON.parse(JSON.stringify(sTemplate));

    syaml.resources.server.props.region = region || 'cn-hangzhou';
    syaml.resources.domain.props.region = region || 'cn-hangzhou';
    syaml.resources.server.props.functionName = functionName;
    syaml.resources.server.props.description =
      (!!description?.length && description?.length > 256
        ? description.slice(0, 250) + '...'
        : description) || 'MCP Server for Function Compute';
    syaml.resources.server.props.environmentVariables = {
      ...syaml.resources.server.props.environmentVariables,
      ...(environmentVariables || {}),
    };
    syaml.resources.server.props.timeout = timeout;
    syaml.resources.server.props.customRuntimeConfig.command = startCommand;
    syaml.resources.server.props.customRuntimeConfig.port = port || 9000;
    syaml.resources.domain.props.routeConfig.routes[0].functionName =
      functionName;

    const yamlPath = path.join(tempDir, 's.yaml');
    fs.writeFileSync(yamlPath, yaml.stringify(syaml, null, 2));

    const result = await sDeploy(yamlPath);
    const domainName = result?.domain?.domainName;

    fs.rmSync(tempDir, { recursive: true, force: true });

    const resultText = `Function deployed successfully, functionName: ${functionName}, function detail page: https://fcnext.console.aliyun.com/${region}/functions/${functionName}. Visit URL: http://${domainName}`;
    logger.log({ resultText });

    // report status
    const resp = await fetch(
      `https://cap-mcp-metrics-pfoztnrgek.cn-hangzhou.fcapp.run?uid=${process.env['FC_ACCOUNT_ID']}`
    );
    if (resp.status !== 200) {
      logger.error('report status failed', resp.status, await resp.text());
    }

    return {
      content: [
        {
          type: 'text',
          text: resultText,
        },
      ],
    };
  } catch (e) {
    console.error(e);

    return {
      content: [
        {
          type: 'text',
          text: `Function deployed failed\n\n${e}`,
        },
      ],
    };
  }
}

export async function removeFc(params: {
  region?: string;
  functionName: string;
}): Promise<CallToolResult> {
  try {
    const { region = 'cn-hangzhou', functionName } = params;

    const tempDir = path.join('/tmp', uuidv4());
    fs.mkdirSync(tempDir, { recursive: true });

    const syaml = JSON.parse(JSON.stringify(sTemplate));
    syaml.resources.server.props.region = region || 'cn-hangzhou';
    syaml.resources.domain.props.region = region || 'cn-hangzhou';
    syaml.resources.server.props.functionName = functionName;
    syaml.resources.domain.props.routeConfig.routes[0].functionName =
      functionName;

    const yamlPath = path.join(tempDir, 's.yaml');
    fs.writeFileSync(yamlPath, yaml.stringify(syaml, null, 2));

    await sRemove(yamlPath);

    return {
      content: [
        {
          type: 'text',
          text: `remove function successfully`,
        },
      ],
    };
  } catch (e) {
    console.error(e);

    return {
      content: [
        {
          type: 'text',
          text: `remove function failed\n\n${e}`,
        },
      ],
    };
  }
}

const systemPrompt = `
你是一个代码撰写助手，请根据我的需要来撰写代码。项目将会通过 HTTP Web 使用

请确保代码交互逻辑满足需要，不要有使用上的 bug。
页面应该尽可能美观，符合大众审美。
输出需要确保满足如下格式，并以 json 形式返回，**不要输出 json 之外的信息**，如果没有特殊需要，不要输出如 \`functionName\` 等可选字段
\`\`\`typescript
type Input = {
  /** 部署地域，支持 cn-hangzhou, cn-beijing, cn-shanghai, cn-shenzhen，默认为 cn-hangzhou  */
  region?: string;
  /** 程序代码  */
  code: {
    /** 相对路径的文件名 */
    filename: string;
    /** 文件内容 */
    content: string
  }[];
  /** 端口号，默认为 9000 */
  port?: number;
  /** 程序描述，不超过 256 字  */
  description?: string;
  /** 需要配置的环境变量  */
  environmentVariables?: Record<string, string>;
  /** 单个请求的超时时间，默认 5 秒  */
  timeout: number;
  /**
   * 安装依赖需要执行的命令，所有依赖都需要被安装在代码同目录内
   *
   * 示例
   * [ "npm", "install" ]
   * [ "pip", "install", "-r", "requirements.txt", "-t", "." ]
   */
  installDependenciesCommand?: string[];
  /**
   * 启动命令，如果是纯 html，可以直接使用 python3 的 http.server 启动
   *
   * 示例
   * [ "python3", "-m", "http.server", "9000" ]
   * [ "npm", "run", "start" ]
   * [ "python", "main.py" ]
   */
  startCommand: string[];
}
\`\`\`
`.trim();

export async function generateCodeAndDeployToFc(params: {
  prompt: string;
  functionName?: string;
}): Promise<CallToolResult> {
  const { prompt, functionName } = params;

  const client = new OpenAI({
    apiKey: process.env['LLM_API_KEY'],
    baseURL:
      process.env['LLM_API_BASE_URL'] ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
  });

  const stream = await client.chat.completions.create({
    model: process.env['LLM_MODEL'] || 'deepseek-v3',
    messages: [
      {
        role: 'system',
        content: process.env['LLM_SYSTEM_PROMPT'] || systemPrompt,
      },
      { role: 'user', content: prompt },
    ],
    stream: true,
  });

  let content = '';
  for await (const chunk of stream) {
    // process.stderr.write(chunk.choices[0].delta.content || '');
    content += chunk.choices[0].delta.content || '';
  }

  try {
    const json = JSON.parse(
      content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1)
    );
    return await deployCodeToFc({
      functionName,
      code: json?.code || {},
      port: json?.port || 9000,
      description: json?.description || '',
      environmentVariables: json?.environmentVariables || {},
      timeout: json?.timeout || 5,
      startCommand: json?.startCommand || [],
      installDependenciesCommand: json?.installDependenciesCommand || [],
    });
  } catch (e) {
    return {
      content: [
        {
          type: 'text',
          text: `Code generate failed\n\n${e}`,
        },
      ],
    };
  }
}

// deployCodeToFc({
//   region: 'cn-hangzhou',
//   code: [
//     {
//       filename: 'main.py',
//       content: `
// import sys
// import os

// vendor_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), 'vendor'))
// sys.path.insert(0, vendor_dir)

// from flask import Flask
// import requests

// app = Flask(__name__)

// @app.route('/')
// def hello():
//     return "Hello from Flask in Aliyun Function Compute!"

// @app.route('/check')
// def check():
//     response = requests.get('https://api.github.com')
//     return f"GitHub API Status: {response.status_code}"

// if __name__ == '__main__':
//     app.run(debug=True, host='0.0.0.0', port=9000)
//       `,
//     },
//     { filename: 'requirements.txt', content: 'flask\nrequests' },
//   ],
//   description: 'description',
//   environmentVariables: {
//     KEY: 'VALUE',
//   },
//   timeout: 52,
//   installDependenciesCommand: [
//     'python3',
//     '-m',
//     'pip',
//     'install',
//     '-r',
//     'requirements.txt',
//     '-t',
//     './vendor',
//   ],
//   startCommand: ['python', 'main.py'],
// }).then(console.log);

// removeFc({
//   region: 'cn-hangzhou',
//   functionName: 'mcp-server-fc-ohyee-test',
// }).then(console.log);

// removeFc({
//   region: 'cn-hangzhou',
//   functionName: 'mcp-server-fc-ohyee-test',
// }).finally(() =>
//   generateCodeAndDeployToFc({
//     prompt: '写一个 2048',
//     functionName: 'mcp-server-fc-ohyee-test',
//   }).then(console.log)
// );
