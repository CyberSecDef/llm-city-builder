// ── Codex driver ─────────────────────────────────────────────────────────────
//  OpenAI's Codex CLI. `codex exec` is one-shot, so every turn is a fresh
//  process: the first creates a thread, the rest `codex exec resume <id>` it.
//  City tools arrive over our MCP server; the system prompt is an AGENTS.md
//  in a private working directory, which is how Codex takes instructions.
//
//  Events: 'text' {text}, 'tool_use' {name,input}, 'usage' {...}, 'turn' {...},
//          'model' {model}, 'status' {text}, 'exit' {code}
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

export class CodexDriver extends EventEmitter {

    constructor ( { mcpUrl, systemPrompt, model, effort, cwd, logFile } ) {
        super();
        this.mcpUrl = mcpUrl; this.systemPrompt = systemPrompt; this.model = model; this.effort = effort;
        this.dir = path.join( cwd, '.codex-mayor' ); this.logFile = logFile;
        this.proc = null; this.busy = false; this.threadId = null; this.stopped = false;
    }

    get name () { return 'codex' + ( this.model ? `:${ this.model }` : '' ); }

    start () {
        fs.mkdirSync( this.dir, { recursive: true } );
        fs.writeFileSync( path.join( this.dir, 'AGENTS.md' ), this.systemPrompt );
        this.stopped = false;
        this.emit( 'model', { model: this.model || 'codex-default' } );
        this.emit( 'status', { text: `started ${ this.name }` } );
    }

    stop () {
        this.stopped = true;
        const p = this.proc; if ( !p ) return;
        try { p.kill( 'SIGTERM' ); } catch {}
        setTimeout( () => { try { p.kill( 'SIGKILL' ); } catch {} }, 3000 );
    }

    // One user turn = one `codex exec` run. Resolves when the process exits.
    send ( text ) {
        if ( this.busy ) throw new Error( 'driver busy' );
        if ( this.stopped ) throw new Error( 'driver stopped' );
        this.busy = true;
        const t0 = Date.now();
        const args = [ 'exec' ];
        if ( this.threadId ) args.push( 'resume', this.threadId );
        args.push(
            // `resume` lacks --sandbox/-C, so both go through -c and the spawn cwd.
            '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"',
            '-c', `mcp_servers.city.url="${ this.mcpUrl }"`,
            '-c', 'mcp_servers.city.default_tools_approval_mode="approve"',
        );
        if ( this.model && !this.threadId ) args.push( '-m', this.model );
        if ( this.effort ) args.push( '-c', `model_reasoning_effort="${ this.effort }"` );
        args.push( text );

        return new Promise( ( resolve, reject ) => {
            let error = null, usage = null;
            const proc = spawn( 'codex', args, { cwd: this.dir, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
            this.proc = proc;
            const kill = () => { try { proc.kill( 'SIGKILL' ); } catch {} };
            process.once( 'exit', kill );

            readline.createInterface( { input: proc.stdout } ).on( 'line', ( line ) => {
                if ( !line.trim() ) return;
                if ( this.logFile ) fs.appendFile( this.logFile, line + '\n', () => {} );
                let ev; try { ev = JSON.parse( line ); } catch { return; }
                const r = this._onEvent( ev );
                if ( r?.usage ) usage = r.usage;
                if ( r?.error ) error = r.error;
            } );
            proc.stderr.on( 'data', ( d ) => {
                const s = String( d ).trim();
                if ( s && !s.startsWith( 'Reading additional input' ) ) this.emit( 'status', { text: `codex: ${ s }` } );
            } );
            proc.on( 'error', ( err ) => { error = err.message; } );
            proc.on( 'exit', ( code ) => {
                process.off( 'exit', kill );
                this.proc = null; this.busy = false;
                if ( code && !error ) error = `codex exited with ${ code }`;
                if ( usage ) this.emit( 'usage', usage );
                this.emit( 'turn', { costUsd: 0, cumulative: false, durationMs: Date.now() - t0, error } );
                if ( error ) reject( new Error( error ) ); else resolve();
            } );
        } );
    }

    _onEvent ( ev ) {
        switch ( ev.type ) {
            case 'thread.started':
                if ( !this.threadId ) { this.threadId = ev.thread_id; this.emit( 'status', { text: `thread ${ ev.thread_id }` } ); }
                return;
            case 'item.started':
                if ( ev.item?.type === 'mcp_tool_call' ) this.emit( 'tool_use', { name: ev.item.tool, input: ev.item.arguments } );
                return;
            case 'item.completed': {
                const it = ev.item || {};
                if ( it.type === 'agent_message' && it.text?.trim() ) this.emit( 'text', { text: it.text.trim() } );
                if ( it.type === 'mcp_tool_call' && it.status === 'failed' ) this.emit( 'status', { text: `tool ${ it.tool } failed: ${ it.error?.message }` } );
                return;
            }
            case 'turn.completed': {
                const u = ev.usage || {};
                const cached = u.cached_input_tokens || 0;
                return { usage: { input: Math.max( 0, ( u.input_tokens || 0 ) - cached ), cacheRead: cached, cacheWrite: u.cache_write_input_tokens || 0, output: u.output_tokens || 0 } };
            }
            case 'turn.failed':
            case 'error':
                return { error: ev.error?.message || ev.message || ev.type };
        }
    }

}
