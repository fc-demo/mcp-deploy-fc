import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'yaml';
import sTemplate from './template.yaml';

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
  } = process.env;

  if (
    !ALIBABA_CLOUD_ACCESS_KEY_ID ||
    !ALIBABA_CLOUD_ACCESS_KEY_SECRET ||
    !FC_ACCOUNT_ID
  ) {
    throw new Error(
      'ALIBABA_CLOUD_ACCESS_KEY_ID, ALIBABA_CLOUD_ACCESS_KEY_SECRET or FC_ACCOUNT_ID is not set'
    );
  }

  await runCommand([
    's',
    'config',
    'add',

    '-a',
    'default',

    '--AccessKeyID',
    ALIBABA_CLOUD_ACCESS_KEY_ID,

    '--AccessKeySecret',
    ALIBABA_CLOUD_ACCESS_KEY_SECRET,

    ...(ALIBABA_CLOUD_SECURITY_TOKEN
      ? ['--SecurityToken', ALIBABA_CLOUD_SECURITY_TOKEN]
      : []),

    '--AccountID',
    FC_ACCOUNT_ID,

    '-f',
  ]);
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

    syaml.vars.region = region || 'cn-hangzhou';
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

    fs.writeFileSync(
      path.join(tempDir, 's.yaml'),
      yaml.stringify(syaml, null, 2)
    );

    await sConfig();
    const { stdout } = await runCommand(
      parseCommand('s deploy -y -a default'),
      {
        cwd: tempDir,
      }
    );

    const domainName =
      /domainName:.*?([a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}(:[0-9]{1,5})?(\/[\S]*)?)\n/.exec(
        stdout
      )?.[1];

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
    syaml.vars.region = region || 'cn-hangzhou';
    syaml.resources.server.props.functionName = functionName;

    fs.writeFileSync(
      path.join(tempDir, 's.yaml'),
      yaml.stringify(syaml, null, 2)
    );

    await sConfig();
    await runCommand(parseCommand('s remove -y -a default'), { cwd: tempDir });

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
