// ── Tool definitions ─────────────────────────────────────────────────────────
//  One list of tools, described with zod, consumed by the MCP server (Claude
//  Code / Codex) and converted to JSON schema for the direct-API driver.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { TOOLS, LINE_TOOLS } from './gameApi.js';

const coord = ( name ) => z.number().int().min( 0 ).describe( `${ name } tile coordinate` );

export const TOOL_DEFS = [
    {
        name: 'get_state',
        description: 'Current city status: date, funds, population, RCI demand (positive = wants more zones of that type), problems, taxes, zone counts. Cheap; call it often.',
        input: {},
    },
    {
        name: 'get_map',
        description: 'ASCII map. With no arguments returns the whole map downsampled (each char = a 4x4 block). Pass x,y,w,h for a full-resolution window (max 64x64). Legend is included in the result.',
        input: {
            x: coord( 'left' ).optional(), y: coord( 'top' ).optional(),
            w: z.number().int().min( 1 ).max( 64 ).optional().describe( 'window width (default 32)' ),
            h: z.number().int().min( 1 ).max( 64 ).optional().describe( 'window height (default 32)' ),
            scale: z.number().int().min( 1 ).max( 16 ).optional().describe( 'downsample factor for the whole-map view (default 4)' ),
        },
    },
    {
        name: 'get_evaluation',
        description: 'Citizen evaluation: approval, top problems, coverage percentages, unemployment.',
        input: {},
    },
    {
        name: 'query',
        description: 'Inspect one tile: what it is, whether it is powered, land value, crime, pollution, growth.',
        input: { x: coord( 'x' ), y: coord( 'y' ) },
    },
    {
        name: 'build',
        description: `Place a zone or building with its TOP-LEFT corner at (x,y). Sizes/costs: ${ Object.entries( TOOLS ).filter( ( [ k ] ) => !LINE_TOOLS.includes( k ) ).map( ( [ k, v ] ) => `${ k } ${ v.size }x${ v.size } $${ v.cost }` ).join( ', ' ) }. RULES: the footprint must border a road tile (lay roads first). The site is prepared for you: trees and existing structures on it are bulldozed ($1/tile), water tiles next to land are filled in ($25/tile); open water with no land beside it cannot be built on. Zones need power (adjacent to a powered tile or a power line) to grow.`,
        input: {
            tool: z.enum( Object.keys( TOOLS ).filter( ( k ) => !LINE_TOOLS.includes( k ) ) ),
            x: coord( 'top-left x' ), y: coord( 'top-left y' ),
        },
    },
    {
        name: 'build_line',
        description: 'Lay road ($10/tile, bridges more), rail ($20) or power line ($5) from (x0,y0) to (x1,y1). Straight, or L-shaped: horizontal leg first, then vertical. Roads form ONE network: after the first road, a road line must touch the existing road somewhere; it is laid outward from that point, and stops at the first tile it cannot cross. Power lines are only needed across gaps; adjacent zones conduct power to each other.',
        input: {
            tool: z.enum( LINE_TOOLS ),
            x0: coord( 'start x' ), y0: coord( 'start y' ), x1: coord( 'end x' ), y1: coord( 'end y' ),
        },
    },
    {
        name: 'bulldoze',
        description: 'Clear a rectangle (max 16x16) starting at top-left (x,y). $1 per tile. Bulldozing a zone centre clears the whole zone. Road tiles whose removal would split the road network are left in place.',
        input: { x: coord( 'x' ), y: coord( 'y' ), w: z.number().int().min( 1 ).max( 16 ).optional(), h: z.number().int().min( 1 ).max( 16 ).optional() },
    },
    {
        name: 'set_speed',
        description: 'Simulation speed: 0 pause, 1 slow, 2 normal, 3 fast.',
        input: { speed: z.number().int().min( 0 ).max( 3 ) },
    },
    {
        name: 'set_budget',
        description: 'Adjust tax rates (0-20 %) per zone type and service funding levels (0-100 %). Omitted fields are unchanged.',
        input: {
            residentialTax: z.number().int().min( 0 ).max( 20 ).optional(), commercialTax: z.number().int().min( 0 ).max( 20 ).optional(), industrialTax: z.number().int().min( 0 ).max( 20 ).optional(),
            roadFunding: z.number().int().min( 0 ).max( 100 ).optional(), fireFunding: z.number().int().min( 0 ).max( 100 ).optional(), policeFunding: z.number().int().min( 0 ).max( 100 ).optional(),
        },
    },
    {
        name: 'say',
        description: 'Talk to the people watching. Use it to explain what you are about to do and why, react to what happened, and answer their messages. One or two sentences; keep it lively.',
        input: { text: z.string().min( 1 ).max( 600 ) },
    },
    {
        name: 'wait',
        description: 'Let the city run for N game months (1-24, ~2 s each at normal speed) and return the state afterwards. Use it to see how your changes play out before doing more.',
        input: { months: z.number().int().min( 1 ).max( 24 ).optional() },
    },
];

// Zod raw shape → JSON schema for the Anthropic API tool format.
export function toJsonSchema ( def ) {
    return { name: def.name, description: def.description, input_schema: z.toJSONSchema( z.object( def.input ) ) };
}

// GameApi result → the text a model sees. Shared by the MCP server and the
// direct-API driver so both mayors read identical tool output.
export function formatResult ( out ) {
    if ( !out.ok ) return `ERROR: ${ out.error }`;
    return typeof out.result === 'string' ? out.result : JSON.stringify( out.result, null, 1 );
}
