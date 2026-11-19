// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.
/**
 * Calls one MCP tool against this database, through the real tool handlers
 * (an in-memory transport, no HTTP), and prints the result as JSON. For the
 * end-to-end tests (desktop sync S3 fires every period-writing tool at a
 * checked-out period).
 *
 *   node --import tsx src/mcpCall.ts <tool> '<json arguments>'
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp/server';
import { db } from './db';

async function main(): Promise<void> {
  const [tool, json] = process.argv.slice(2);
  if (!tool) throw new Error('usage: mcpCall.ts <tool> <json arguments>');
  const args = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  const server = createMcpServer('e2e');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(clientSide);
  const result = await client.callTool({ name: tool, arguments: args });
  process.stdout.write(JSON.stringify(result) + '\n');
  await client.close();
  await server.close();
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void db.destroy());
