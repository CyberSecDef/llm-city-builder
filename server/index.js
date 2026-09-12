// ── llm-city-builder server ─────────────────────────────────────────────────
//  Serves the game's static files, runs the simulation headless, and relays
//  it to browser viewers over WebSocket.  `node server/index.js`
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Sim } from './sim.js';
import { Relay } from './relay.js';
import { GameApi } from './gameApi.js';
import { CityMcp } from './mcp.js';
import { AgentHost, SYSTEM_PROMPT } from './agent.js';
import { ClaudeCodeDriver } from './drivers/claudeCode.js';
import { AnthropicApiDriver } from './drivers/anthropicApi.js';
import { CodexDriver } from './drivers/codex.js';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const PORT = Number( process.env.PORT ) || 8787;

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
    '.hdr': 'application/octet-stream', '.ktx2': 'image/ktx2',
};

const server = http.createServer( async ( req, res ) => {

    if ( await mcp.handle( req, res ) ) return;

    let urlPath = decodeURIComponent( new URL( req.url, 'http://x' ).pathname );
    if ( urlPath === '/' ) urlPath = '/watch.html';

    const file = path.join( ROOT, urlPath );
    if ( !file.startsWith( ROOT ) ) { res.writeHead( 403 ); return res.end(); }

    fs.stat( file, ( err, st ) => {
        if ( err || !st.isFile() ) { res.writeHead( 404 ); return res.end( 'not found' ); }
        res.writeHead( 200, {
            'Content-Type': MIME[ path.extname( file ).toLowerCase() ] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        } );
        fs.createReadStream( file ).pipe( res );
    } );

} );

const sim   = new Sim( 30 );
const relay = new Relay( sim, server );
const api   = new GameApi( sim );
const mcp   = new CityMcp( api );

sim.on( 'message', ( d ) => {
    if ( d.tell === 'TICKERROR' ) console.error( 'sim tick error:', d.message, d.stack );
    if ( d.tell === 'NEWMAP' )    console.log( 'map generated', d.mapSize.join( 'x' ), d.island ? '(island)' : '' );
} );

server.listen( PORT, () => {
    console.log( `llm-city-builder  http://localhost:${ PORT }/` );
    sim.newGame( [ 128, 128 ] );
    if ( process.env.DEMO ) demoBuild();
    if ( process.env.AGENT ) startAgent( process.env.AGENT );
} );

// AGENT=claude-code[:model] | api[:model] | codex[:model]
//   e.g. AGENT=claude-code:sonnet, AGENT=api:claude-opus-5, AGENT=codex
function startAgent ( spec ) {
    const [ kind, model ] = spec.split( ':' );
    let driver;
    if ( kind === 'claude-code' ) {
        driver = new ClaudeCodeDriver( {
            mcpUrl: `http://localhost:${ PORT }/mcp`, systemPrompt: SYSTEM_PROMPT, model,
            maxBudgetUsd: Number( process.env.MAX_BUDGET_USD ) || undefined,
            cwd: path.join( ROOT, 'server' ), logFile: process.env.AGENT_LOG,
        } );
    } else if ( kind === 'api' ) {
        driver = new AnthropicApiDriver( api, {
            systemPrompt: SYSTEM_PROMPT, model, logFile: process.env.AGENT_LOG,
            maxContextTokens: Number( process.env.MAX_CONTEXT_TOKENS ) || undefined,
            thinking: process.env.THINKING !== 'off',
        } );
    } else if ( kind === 'codex' ) {
        driver = new CodexDriver( {
            mcpUrl: `http://localhost:${ PORT }/mcp`, systemPrompt: SYSTEM_PROMPT, model,
            effort: process.env.CODEX_EFFORT, cwd: path.join( ROOT, 'server' ), logFile: process.env.AGENT_LOG,
        } );
    } else {
        console.error( `unknown agent "${ kind }"` ); return;
    }
    const host = new AgentHost( api, driver );
    relay.attachAgent( host );
    host.on( 'entry', ( e ) => {
        const line = e.kind === 'say' ? `🗣 ${ e.text }` : e.kind === 'tool' ? `⚙ ${ e.name } ${ JSON.stringify( e.args ) } → ${ e.ok ? e.result : 'ERROR ' + e.result }` : e.kind === 'user' ? `💬 ${ e.name }: ${ e.text }` : `· ${ e.text }`;
        console.log( '\n' + line );
    } );
    host.start().catch( ( err ) => console.error( 'agent failed:', err.message ) );
    for ( const sig of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) process.on( sig, () => { host.stop(); setTimeout( () => process.exit( 0 ), 500 ); } );
}

// DEMO=1: lay down a small starter town so the viewer has something to show
// before an agent is wired up.
function demoBuild () {
    const click = ( tool, pts ) => {
        sim.post( { tell: 'TOOL', name: tool } );
        for ( const [ x, y ] of pts ) sim.post( { tell: 'MAPCLICK', x, y } );
    };
    const line = ( x0, y0, x1, y1 ) => {
        const pts = [];
        for ( let x = x0; x <= x1; x++ ) for ( let y = y0; y <= y1; y++ ) pts.push( [ x, y ] );
        return pts;
    };
    click( 'road', line( 40, 60, 80, 60 ) );
    click( 'road', line( 60, 40, 60, 80 ) );
    click( 'residential', [ [ 50, 56 ], [ 54, 56 ], [ 50, 64 ], [ 54, 64 ] ] );
    click( 'commercial',  [ [ 66, 56 ], [ 66, 64 ] ] );
    click( 'industrial',  [ [ 72, 56 ], [ 72, 64 ] ] );
    click( 'coal',        [ [ 64, 46 ] ] );
    click( 'wire',        line( 64, 50, 64, 55 ) );
    sim.post( { tell: 'TOOL', name: 'none' } );
}

// Once a second, a one-line status so the terminal shows the city is alive.
setInterval( () => {
    const i = sim.infos;
    if ( !i.length ) return;
    const l = relay.agent ? relay.agent.ledger.snapshot() : null;
    const cost = l ? `  tokens ${ l.input + l.cacheRead + l.cacheWrite }in/${ l.output }out${ l.priced === false ? '' : ' $' + l.costUsd.toFixed( 3 ) }` : '';
    process.stdout.write( `\r${ i[ 0 ] }  pop ${ i[ 3 ] }  $${ i[ 4 ] }  score ${ i[ 2 ] }  viewers ${ relay.viewerCount }${ cost }   ` );
}, 1000 );
