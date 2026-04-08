/** @jest-environment node */

import path from 'node:path';
import { jest } from '@jest/globals';

const {
    parseArgs,
    printSummary,
    LOCAL_SNAPDRIFT_DIR,
    LOCAL_BASELINE_SUBDIR,
    LOCAL_CURRENT_SUBDIR,
    LOCAL_DIFF_SUBDIR
} = await import('../lib/cli.mjs');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
    it('defaults to diff command and CWD-relative .snapdrift dirs when no args given', () => {
        const opts = parseArgs(['node', 'snapdrift']);
        expect(opts.command).toBe('diff');
        expect(opts.open).toBe(false);
        expect(opts.configPath).toBeUndefined();
        expect(opts.routes).toEqual([]);
        expect(opts.baselineDir).toBe(path.resolve(LOCAL_SNAPDRIFT_DIR, LOCAL_BASELINE_SUBDIR));
        expect(opts.currentDir).toBe(path.resolve(LOCAL_SNAPDRIFT_DIR, LOCAL_CURRENT_SUBDIR));
        expect(opts.diffDir).toBe(path.resolve(LOCAL_SNAPDRIFT_DIR, LOCAL_DIFF_SUBDIR));
    });

    it('parses capture command', () => {
        const opts = parseArgs(['node', 'snapdrift', 'capture']);
        expect(opts.command).toBe('capture');
    });

    it('parses diff command explicitly', () => {
        const opts = parseArgs(['node', 'snapdrift', 'diff']);
        expect(opts.command).toBe('diff');
    });

    it('parses --open flag', () => {
        const opts = parseArgs(['node', 'snapdrift', 'diff', '--open']);
        expect(opts.open).toBe(true);
    });

    it('parses --config flag', () => {
        const opts = parseArgs(['node', 'snapdrift', 'diff', '--config', 'custom/snapdrift.json']);
        expect(opts.configPath).toBe('custom/snapdrift.json');
    });

    it('parses --routes as comma-separated list', () => {
        const opts = parseArgs(['node', 'snapdrift', 'diff', '--routes', 'home,about, contact ']);
        expect(opts.routes).toEqual(['home', 'about', 'contact']);
    });

    it('parses --baseline-dir as resolved absolute path', () => {
        const opts = parseArgs(['node', 'snapdrift', 'capture', '--baseline-dir', 'some/dir']);
        expect(path.isAbsolute(opts.baselineDir)).toBe(true);
        expect(opts.baselineDir).toBe(path.resolve('some/dir'));
    });

    it('parses --current-dir', () => {
        const opts = parseArgs(['node', 'snapdrift', 'diff', '--current-dir', 'my/current']);
        expect(opts.currentDir).toBe(path.resolve('my/current'));
    });

    it('parses --diff-dir', () => {
        const opts = parseArgs(['node', 'snapdrift', 'diff', '--diff-dir', 'my/diff']);
        expect(opts.diffDir).toBe(path.resolve('my/diff'));
    });

    it('handles multiple flags together', () => {
        const opts = parseArgs([
            'node', 'snapdrift', 'diff',
            '--open',
            '--config', '.github/snapdrift.json',
            '--routes', 'a,b',
            '--diff-dir', 'out/diff'
        ]);
        expect(opts.open).toBe(true);
        expect(opts.configPath).toBe('.github/snapdrift.json');
        expect(opts.routes).toEqual(['a', 'b']);
        expect(opts.diffDir).toBe(path.resolve('out/diff'));
    });

    it('returns unknown command as-is', () => {
        const opts = parseArgs(['node', 'snapdrift', 'unknown-cmd']);
        expect(opts.command).toBe('unknown-cmd');
    });
});

// ---------------------------------------------------------------------------
// printSummary
// ---------------------------------------------------------------------------

describe('printSummary', () => {
    let output;

    beforeEach(() => {
        output = '';
        jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            output += chunk;
            return true;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('prints clean status with checkmark', () => {
        printSummary({
            status: 'clean',
            totalScreenshots: 3,
            matchedScreenshots: 3,
            changedScreenshots: 0
        });
        expect(output).toContain('✅');
        expect(output).toContain('Clean');
        expect(output).toContain('Routes:   3');
        expect(output).toContain('Matched:  3');
    });

    it('prints changes-detected status with yellow circle', () => {
        printSummary({
            status: 'changes-detected',
            totalScreenshots: 2,
            matchedScreenshots: 1,
            changedScreenshots: 1,
            changed: [{ id: 'home', mismatchRatio: 0.05 }]
        });
        expect(output).toContain('🟡');
        expect(output).toContain('Drift detected');
        expect(output).toContain('Changed:  1');
        expect(output).toContain('home (5.00% diff)');
    });

    it('prints failed status with red X', () => {
        printSummary({
            status: 'failed',
            totalScreenshots: 1,
            matchedScreenshots: 0,
            errors: [{ id: 'home', error: 'timeout' }]
        });
        expect(output).toContain('❌');
        expect(output).toContain('Errors:   1');
    });

    it('prints missing screenshots count', () => {
        printSummary({
            status: 'changes-detected',
            totalScreenshots: 2,
            matchedScreenshots: 0,
            missingInBaseline: 1,
            missingInCurrent: 1
        });
        expect(output).toContain('Missing:  2');
    });

    it('prints dimension changes count', () => {
        printSummary({
            status: 'changes-detected',
            totalScreenshots: 1,
            matchedScreenshots: 0,
            dimensionChanges: [{ id: 'home' }]
        });
        expect(output).toContain('Dim diff: 1');
    });

    it('omits Changed/Missing/Errors/Dim diff lines when all zero', () => {
        printSummary({
            status: 'clean',
            totalScreenshots: 1,
            matchedScreenshots: 1
        });
        expect(output).not.toContain('Changed');
        expect(output).not.toContain('Missing');
        expect(output).not.toContain('Errors');
        expect(output).not.toContain('Dim diff');
    });

    it('falls back to selectedRoutes length when totalScreenshots is undefined', () => {
        printSummary({
            status: 'clean',
            selectedRoutes: [{ id: 'a' }, { id: 'b' }],
            matchedScreenshots: 2
        });
        expect(output).toContain('Routes:   2');
    });
});
