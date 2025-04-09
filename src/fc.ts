import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import loadComponent from '@serverless-devs/load-component';
import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'yaml';
import sTemplate from './template.yaml';
import { Logger } from './logger';

async function runCommand(shell: string[], options?: SpawnOptionsWithoutStdio) {
  return await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      console.log(`run command: ${shell.join(' ')}`);

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

  await runCommand([
    's',
    'config',
    'add',
    '-a',
    'default',

    '--AccessKeyID',
    accessKeyID,

    '--AccessKeySecret',
    accessKeySecret,

    ...(securityToken ? ['--SecurityToken', securityToken] : []),

    '--AccountID',
    accountID,

    '-f',
  ]);

  return {
    accountID,
    accessKeyID,
    accessKeySecret,
    securityToken,
  };
}

async function runS(command: string, yamlPath: string) {
  const config = await sConfig();
  const logger = new Logger();

  const content = fs.readFileSync(yamlPath, 'utf8');
  const yamlObject = yaml.parse(content);

  const results: Record<string, any> = {};

  for (const [resourceKey, resource] of Object.entries<any>(
    yamlObject.resources
  )) {
    console.log('s', command, resource?.component);

    const component = await loadComponent(resource?.component, {
      logger,
    });

    const result = await component[command]({
      props: resource?.props,
      name: yamlObject.name,
      args: ['-t', yamlPath, '-y', '--silent'],
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
    region,
    code,
    description,
    environmentVariables,
    timeout,
    installDependenciesCommand,
    startCommand,
    port,
  } = params;
  console.log(params);

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

    const functionName = `mcp-deploy-fc-${uuidv4()}`;
    // const functionName = `mcp-deploy-fc-abcd`;

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

    console.log({ tempDir });
    fs.rmSync(tempDir, { recursive: true, force: true });

    return {
      content: [
        {
          type: 'text',
          text: `Function deployed successfully, function: [${functionName}](https://fcnext.console.aliyun.com/${region}/functions/${functionName}). Visit URL: http://${domainName}`,
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
