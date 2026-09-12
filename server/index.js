// ── llm-city-builder server ─────────────────────────────────────────────────
//  Serves the game's static files, runs the simulation headless, and relays
//  it to browser viewers over WebSocket.  `node server/index.js`
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';

import { Sim } from './sim.js';
import { Relay } from './relay.js';
import { GameApi } from './gameApi.js';
import { CityMcp } from './mcp.js';
import { AgentHost, SYSTEM_PROMPT } from './agent.js';
import { ClaudeCodeDriver } from './drivers/claudeCode.js';
import { AnthropicApiDriver } from './drivers/anthropicApi.js';
import { CodexDriver } from './drivers/codex.js';
import { GameSave } from './save.js';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const PORT = Number( process.env.PORT ) || 8787;
const HOST = process.env.HOST || '0.0.0.0';     // LAN by default; HOST=127.0.0.1 to keep it local

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
const relay = new Relay( sim, server, { adminToken: () => ADMIN_TOKEN, onAdmin: ( a, m ) => onAdmin( a, m ) } );
const api   = new GameApi( sim );
const mcp   = new CityMcp( api );

sim.on( 'message', ( d ) => {
    if ( d.tell === 'TICKERROR' ) console.error( 'sim tick error:', d.message, d.stack );
    if ( d.tell === 'NEWMAP' )    console.log( 'map generated', d.mapSize.join( 'x' ), d.island ? '(island)' : '' );
} );

// ── game lifecycle ──────────────────────────────────────────────────────────
//  GAME=path.json is the save file (default saves/latest.json). If it exists
//  at boot the city, transcript and driver conversation come back from it;
//  otherwise a fresh MAP_SIZE map is generated. Autosaved every SAVE_EVERY s
//  and on shutdown.

const GAME_FILE  = path.resolve( ROOT, process.env.GAME || 'saves/latest.json' );
const SAVE_EVERY = ( Number( process.env.SAVE_EVERY ) || 60 ) * 1000;
const MAP_SIZE   = parseMapSize( process.env.MAP_SIZE ) || [ 128, 128 ];
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes( 12 ).toString( 'hex' );

const save = new GameSave( GAME_FILE );
let host = null, agentSpec = process.env.AGENT || null, saved = null;

if ( save.exists() ) {
    try { saved = save.read(); console.log( `restoring ${ path.relative( ROOT, GAME_FILE ) } (saved ${ saved.savedAt })` ); }
    catch ( err ) { console.error( `cannot read ${ GAME_FILE }: ${ err.message }` ); process.exit( 1 ); }
    if ( !agentSpec && saved.agentSpec ) agentSpec = saved.agentSpec;
}

server.listen( PORT, HOST, () => {
    const urls = [ 'localhost', ...lanAddresses() ].map( ( h ) => `http://${ h }:${ PORT }/` );
    console.log( `llm-city-builder  ${ urls.join( '  ' ) }` );
    console.log( `owner token       ${ ADMIN_TOKEN }   (open ${ urls[ 1 ] || urls[ 0 ] }?admin=${ ADMIN_TOKEN })` );
    if ( saved ) sim.load( saved.city );
    else newGame( MAP_SIZE );
    if ( process.env.DEMO && !saved ) demoBuild();
    if ( agentSpec ) startAgent( agentSpec, saved?.agentSpec === agentSpec ? saved.agent : null );
    setInterval( () => save.write( { sim, host, agentSpec } ).catch( ( e ) => console.error( 'autosave failed:', e.message ) ), SAVE_EVERY );
} );

for ( const sig of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) process.on( sig, shutdown );
async function shutdown () {
    host?.stop();
    try { await save.write( { sim, host, agentSpec } ); console.log( `\nsaved ${ path.relative( ROOT, GAME_FILE ) }` ); }
    catch ( e ) { console.error( 'save on exit failed:', e.message ); }
    setTimeout( () => process.exit( 0 ), 300 );
}

// Owner actions arriving over the relay with a valid token. Returns an
// error string, or nothing on success.
async function onAdmin ( action, msg ) {
    switch ( action ) {
        case 'pause':    if ( !host ) return 'no agent'; host.pause( 'owner' ); return;
        case 'resume':   if ( !host ) return 'no agent'; return host.resume() === false ? `spend cap $${ host.capUsd } reached; raise it first` : undefined;
        case 'stop':     if ( !host ) return 'no agent'; host.stop(); return;
        case 'save':     await save.write( { sim, host, agentSpec } ); return;
        case 'set_cap':  if ( !host ) return 'no agent'; host.setCap( Number( msg.usd ) || 0 ); return;
        case 'new_game': {
            const size = parseMapSize( msg.mapSize ) || MAP_SIZE;
            host?.stop(); host = null; relay.attachAgent( null );
            newGame( size );
            if ( agentSpec ) startAgent( agentSpec, null );
            return;
        }
        default: return `unknown action ${ action }`;
    }
}

// Fresh map plus the founding road (see GameApi.starterRoad).
function newGame ( size ) {
    sim.newGame( size );
    const r = api.starterRoad();
    console.log( `starter road along the ${ r.side } edge, (${ r.from }) → (${ r.to })` );
}

function lanAddresses () {
    if ( HOST !== '0.0.0.0' && HOST !== '::' ) return [ HOST ];
    return Object.values( os.networkInterfaces() ).flat().filter( ( i ) => i && i.family === 'IPv4' && !i.internal ).map( ( i ) => i.address );
}

function parseMapSize ( s ) {
    const m = /^(\d+)x(\d+)$/.exec( String( s || '' ) );
    if ( !m ) return null;
    const w = Number( m[ 1 ] ), h = Number( m[ 2 ] );
    return w >= 32 && h >= 32 && w <= 512 && h <= 512 ? [ w, h ] : null;
}

// AGENT=claude-code[:model] | api[:model] | codex[:model]
//   e.g. AGENT=claude-code:sonnet, AGENT=api:claude-opus-5, AGENT=codex
function startAgent ( spec, restoreFrom ) {
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
            thinking: process.env.THINKING !== 'off', effort: process.env.EFFORT,
        } );
    } else if ( kind === 'codex' ) {
        driver = new CodexDriver( {
            mcpUrl: `http://localhost:${ PORT }/mcp`, systemPrompt: SYSTEM_PROMPT, model,
            effort: process.env.CODEX_EFFORT, cwd: path.join( ROOT, 'server' ), logFile: process.env.AGENT_LOG,
        } );
    } else {
        console.error( `unknown agent "${ kind }"` ); return;
    }
    host = new AgentHost( api, driver );
    if ( Number( process.env.MAX_BUDGET_USD ) ) host.setCap( Number( process.env.MAX_BUDGET_USD ) );
    if ( restoreFrom ) host.restore( restoreFrom );
    relay.attachAgent( host );
    host.on( 'entry', ( e ) => {
        const line = e.kind === 'say' ? `🗣 ${ e.text }` : e.kind === 'tool' ? `⚙ ${ e.name } ${ JSON.stringify( e.args ) } → ${ e.ok ? e.result : 'ERROR ' + e.result }` : e.kind === 'user' ? `💬 ${ e.name }: ${ e.text }` : `· ${ e.text }`;
        console.log( '\n' + line );
    } );
    host.start().catch( ( err ) => console.error( 'agent failed:', err.message ) );
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
    const l = host ? host.ledger.snapshot() : null;
    const cost = l ? `  tokens ${ l.input + l.cacheRead + l.cacheWrite }in/${ l.output }out${ l.priced === false ? '' : ' $' + l.costUsd.toFixed( 3 ) }` : '';
    process.stdout.write( `\r${ i[ 0 ] }  pop ${ i[ 3 ] }  $${ i[ 4 ] }  score ${ i[ 2 ] }  viewers ${ relay.viewerCount }${ cost }   ` );
}, 1000 );
