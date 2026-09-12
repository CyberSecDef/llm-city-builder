// ── MCP server ───────────────────────────────────────────────────────────────
//  Exposes GameApi over MCP streamable HTTP at /mcp so local agent CLIs
//  (Claude Code, Codex, ...) can play. Stateless: a fresh server+transport per
//  request, which is the documented pattern for this transport.
// ─────────────────────────────────────────────────────────────────────────────

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOOL_DEFS, formatResult } from './tools.js';

export class CityMcp {

    constructor ( api, { path = '/mcp' } = {} ) {
        this.api  = api;
        this.path = path;
    }

    // Returns true if the request was for us (and has been handled).
    async handle ( req, res ) {
        const url = new URL( req.url, 'http://x' );
        if ( url.pathname !== this.path ) return false;
        const server = this._makeServer();
        const transport = new StreamableHTTPServerTransport( { sessionIdGenerator: undefined } );
        res.on( 'close', () => { transport.close(); server.close(); } );
        try {
            await server.connect( transport );
            await transport.handleRequest( req, res );
        } catch ( err ) {
            console.error( 'mcp error', err );
            if ( !res.headersSent ) { res.writeHead( 500 ); res.end( 'mcp error' ); }
        }
        return true;
    }

    _makeServer () {
        const server = new McpServer( { name: 'city', version: '0.1.0' } );
        for ( const def of TOOL_DEFS ) {
            server.registerTool( def.name, { description: def.description, inputSchema: def.input }, async ( args ) => {
                const out = await this.api[ def.name ]( args || {} );
                return { content: [ { type: 'text', text: formatResult( out ) } ], isError: !out.ok };
            } );
        }
        return server;
    }

}
