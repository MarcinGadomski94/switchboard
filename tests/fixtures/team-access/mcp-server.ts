/**
 * D100-T2 test fixture: a tiny stdio MCP server (the access "Test connection" and
 * launcher tests). It lists one tool, `acme_report`, only when `ACME_REPORTS_TOKEN`
 * is in its environment (else it exits: a wrong setup fails the test connection).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

if (!process.env['ACME_REPORTS_TOKEN']) {
  process.stderr.write('ACME_REPORTS_TOKEN is not set\n');
  process.exit(3);
}
const server = new McpServer({ name: 'acme-reports-fixture', version: '1.0.0' });
server.registerTool('acme_report', { title: 'Acme report', description: 'A fixture tool.' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
await server.connect(new StdioServerTransport());
