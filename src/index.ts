#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express, { Request, Response } from 'express';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { initServer } from './mcp-server';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('mode', {
      type: 'string',
      default: 'stdio',
      description: 'MCP server mode(stdio/sse)',
    })
    .option('port', {
      type: 'number',
      default: 9000,
      description: 'Port to listen on (server mode)',
    })
    .option('host', {
      type: 'string',
      default: '0.0.0.0',
      description: 'Host to listen on (server mode)',
    }).argv;

  switch (argv.mode.toLowerCase()) {
    case 'stdio':
      console.log(`start sdtio mode`);
      const server = initServer();
      server.connect(new StdioServerTransport());
      break;
    case 'sse':
      console.log(`start SSE mode on ${argv.host}:${argv.port}`);
      const app = express();

      const transports: { [sessionId: string]: SSEServerTransport } = {};

      app.get('/sse', async (req: Request, res: Response) => {
        console.log('sse connected');

        const transport = new SSEServerTransport('/messages', res);
        transports[transport.sessionId] = transport;
        console.log('sse init session id', transport.sessionId);

        res.on('close', () => {
          console.log('sse closed', transport.sessionId);
          delete transports[transport.sessionId];
        });

        const server = initServer();
        await server.connect(transport);
      });

      app.post('/messages', async (req: Request, res: Response) => {
        const sessionId = req.query.sessionId as string;

        console.log('receive message, sessionId', sessionId);
        console.log(req.body);

        const transport = transports[sessionId];
        if (transport) {
          await transport.handlePostMessage(req, res);
          console.log('message finished, sessionId', sessionId);
        } else {
          console.log('session id is missing', sessionId);
          res.status(400).send('No transport found for sessionId');
        }
      });

      app.listen(argv.port, argv.host);

      break;
    default:
      console.error('MCP server mode must be stdio or sse');
  }
}

main();
