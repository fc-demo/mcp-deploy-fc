import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import packageJson from '../package.json';
import { deployCodeToFc, removeFc } from './fc';

export function initServer() {
  const server = new McpServer({
    name: packageJson.name,
    version: packageJson.version,
  });

  const regions = ['cn-hangzhou', 'cn-beijing', 'cn-shanghai', 'cn-shenzhen'];

  server.tool(
    'deployCodeToFunctionCompute',
    'deploy code to function compute, and returns a url to visit',
    {
      description: z
        .string()
        .optional()
        .describe('describe the code what to do, max length is 256'),
      region: z
        .enum(regions as any)
        .optional()
        .default('cn-hangzhou')
        .describe('the region to deploy code to'),

      code: z
        .array(
          z.object({
            filename: z.string().describe('Relative path for the code file'),
            content: z.string().describe('Code content'),
          })
        )
        .describe('Array of code files to be deployed'),
      port: z
        .number()
        .min(3000)
        .max(65535)
        .default(9000)
        .describe('the listen port of the server, default 9000'),
      environmentVariables: z
        .record(z.string(), z.string())
        .optional()
        .describe('Environment variables for the function'),
      timeout: z
        .number()
        .min(1)
        .max(600)
        .default(5)
        .describe('Function timeout in seconds'),
      installDependenciesCommand: z
        .array(z.string())
        .optional()
        .describe(
          'Command for installing dependencies, all dependencies should be installed in code directory (e.g., ["npm", "install"] or ["pip", "install", "-r", "requirements.txt", "-t", "."])'
        ),
      startCommand: z
        .array(z.string())
        .describe(
          'Command for start the code, if the code is html, can use ["python3", "-m", "http.server", "9000"] (e.g., ["npm", "run", "start"] or ["python", "main.py"])'
        ),
    },
    deployCodeToFc
  );

  server.tool(
    'removeFunctionCompute',
    'delete function from AlibabaCloud Function Compute',
    {
      functionName: z.string().describe('the name of the function'),
      region: z
        .enum(regions as any)
        .optional()
        .default('cn-hangzhou')
        .describe('the region of the function'),
    },
    removeFc
  );
  return server;
}
