import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';
import { z } from 'zod';
import packageJson from '../package.json';
import { deployCodeToFc, generateCodeAndDeployToFc, removeFc } from './fc';
import { logger } from './logger';
import fs from 'fs';
import path from 'path';

class Cache<T> {
  path: string;
  constructor(path: string = '/tmp/cache') {
    fs.mkdirSync(path, { recursive: true });

    this.path = path;
  }

  get(key: string): T | undefined {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.path, key), { encoding: 'utf-8' })
      );
    } catch (e) {
      logger.error(e);
      return undefined;
    }
  }

  set(key: string, value: T) {
    try {
      fs.writeFileSync(path.join(this.path, key), JSON.stringify(value), {
        encoding: 'utf-8',
      });
    } catch (e) {
      logger.error(e);
    }
  }
}

function withCache<T>(
  func: (params: T) => Promise<CallToolResult>
): (params: T) => Promise<CallToolResult> {
  const _cache = new Cache<{
    pending: boolean;
    result?: CallToolResult;
    error?: Error;
  }>();
  return async (params: T) => {
    const raw = JSON.stringify(params);
    const key = crypto.createHash('md5').update(raw).digest('hex');
    logger.info('cache key', key);

    if (typeof _cache.get(key) === 'undefined') {
      // no task
      _cache.set(key, { pending: true, result: undefined, error: undefined });

      try {
        const result = await func(params);
        _cache.set(key, { pending: false, result });
      } catch (e) {
        _cache.set(key, { pending: false, error: e as Error });
      }
    } else if (_cache.get(key)?.pending) {
      while (_cache.get(key)?.pending) {
        logger.log('waiting for task to finish');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    const c = _cache.get(key) 

    if (!!c?.error) {
      throw c?.error;
    }

    return c?.result as CallToolResult;
  };
}

export function initServer() {
  const server = new McpServer({
    name: packageJson.name,
    version: packageJson.version,
  });

  const regions = ['cn-hangzhou', 'cn-beijing', 'cn-shanghai', 'cn-shenzhen'];

  // server.tool(
  //   'deployCodeToFunctionCompute',
  //   'deploy code to function compute, and returns a url to visit',
  //   {
  //     functionName: z
  //       .string()
  //       .regex(/^[_a-zA-Z][-_a-zA-Z0-9]*$/)
  //       .optional()
  //       .describe(
  //         "the name of the function. If the function name has exists, it will update the old one. If there's no special requirement, you can leave this field blank."
  //       ),
  //     description: z
  //       .string()
  //       .optional()
  //       .describe('describe the code what to do, max length is 256'),
  //     region: z
  //       .enum(regions as any)
  //       .optional()
  //       .default('cn-hangzhou')
  //       .describe('the region to deploy code to'),

  //     code: z
  //       .array(
  //         z.object({
  //           filename: z.string().describe('Relative path for the code file'),
  //           content: z.string().describe('Code content'),
  //         })
  //       )
  //       .describe('Array of code files to be deployed'),
  //     port: z
  //       .number()
  //       .min(3000)
  //       .max(65535)
  //       .default(9000)
  //       .describe('the listen port of the server, default 9000'),
  //     environmentVariables: z
  //       .record(z.string(), z.string())
  //       .optional()
  //       .describe('Environment variables for the function'),
  //     timeout: z
  //       .number()
  //       .min(1)
  //       .max(600)
  //       .default(5)
  //       .describe('Function timeout in seconds'),
  //     installDependenciesCommand: z
  //       .array(z.string())
  //       .optional()
  //       .describe(
  //         'Command for installing dependencies, all dependencies should be installed in code directory (e.g., ["npm", "install"] or ["pip", "install", "-r", "requirements.txt", "-t", "."])'
  //       ),
  //     startCommand: z
  //       .array(z.string())
  //       .describe(
  //         'Command for start the code, if the code is html, can use ["python3", "-m", "http.server", "9000"] (e.g., ["npm", "run", "start"] or ["python", "main.py"])'
  //       ),
  //   },
  //   deployCodeToFc
  // );

  server.tool(
    'removeFunctionCompute',
    'delete function from AlibabaCloud Function Compute',
    {
      functionName: z
        .string()
        .describe('the name of the function')
        .regex(/^[_a-zA-Z][-_a-zA-Z0-9]*$/),
      region: z
        .enum(regions as any)
        .optional()
        .default('cn-hangzhou')
        .describe('the region of the function'),
    },
    removeFc
  );

  server.tool(
    'generateCodeAndDeployToFc',
    'use LLM to generate code and deploy to AlibabaCloud Function, then return the url to visit the project',
    {
      // functionName: z
      //   .string()
      //   .describe(
      //     "the name of the function, if the function name has exists, it will update the old one. If there's no special requirement, you can leave this field blank."
      //   )
      //   .regex(/^[_a-zA-Z][-_a-zA-Z0-9]*$/)
      //   .optional(),
      // region: z
      //   .enum(regions as any)
      //   .optional()
      //   .default('cn-hangzhou')
      //   .describe('the region of the function'),
      prompt: z.string().describe('the prompt to generate code'),
    },
    withCache(generateCodeAndDeployToFc)
  );
  return server;
}
