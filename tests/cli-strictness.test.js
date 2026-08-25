/** @jest-environment node */

const { parseArgs, buildOpenCommand } = await import('../lib/cli.mjs');

// ---------------------------------------------------------------------------
// parseArgs — strict flag handling (findings 1)
// ---------------------------------------------------------------------------

describe('parseArgs — rejects unknown flags and missing option values', () => {
  it('rejects an unknown long flag with a clear error', () => {
    expect(() => parseArgs(['node', 'snapdrift', 'diff', '--frobnicate']))
      .toThrow(/Unknown flag: --frobnicate/);
  });

  it('rejects an unknown short flag', () => {
    expect(() => parseArgs(['node', 'snapdrift', 'diff', '-x']))
      .toThrow(/Unknown flag: -x/);
  });

  it('rejects a value-required flag at end of arguments', () => {
    expect(() => parseArgs(['node', 'snapdrift', 'diff', '--config']))
      .toThrow(/Missing value for flag --config/);
  });

  it('rejects a value-required flag whose value is another flag', () => {
    expect(() => parseArgs(['node', 'snapdrift', 'diff', '--config', '--routes']))
      .toThrow(/Missing value for flag --config/);
  });

  it('rejects a missing --from-snap-action value', () => {
    expect(() => parseArgs(['node', 'snapdrift', 'init', '--from-snap-action']))
      .toThrow(/Missing value for flag --from-snap-action/);
  });

  it('still parses known flags and their values normally', () => {
    const opts = parseArgs([
      'node', 'snapdrift', 'diff',
      '--config', '.github/snapdrift.json',
      '--routes', 'home,about'
    ]);
    expect(opts.configPath).toBe('.github/snapdrift.json');
    expect(opts.routes).toEqual(['home', 'about']);
  });

  it('preserves the silent-ignore contract for invalid --to/--from values', () => {
    expect(parseArgs(['node', 'snapdrift', 'migrate-baselines', '--to', 'invalid']).to).toBeUndefined();
    expect(
      parseArgs(['node', 'snapdrift', 'migrate-baselines', '--to', 'local', '--from', 'invalid']).from
    ).toBeUndefined();
  });

  it('still accepts the boolean --accept-cross-engine flag', () => {
    const opts = parseArgs([
      'node', 'snapdrift', 'migrate-baselines', '--to', 'local', '--from', 'snap', '--accept-cross-engine'
    ]);
    expect(opts.acceptCrossEngine).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildOpenCommand — argument-safe report opening (finding 2)
// ---------------------------------------------------------------------------

describe('buildOpenCommand — path passed as a single argv element', () => {
  it('passes the file path as one argument so shell metacharacters are not interpreted', () => {
    const malicious = '/tmp/report.html; touch /tmp/pwned-$UID';
    const { cmd, args } = buildOpenCommand(malicious);

    expect(typeof cmd).toBe('string');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain(malicious);
    // The whole string is a single argument; nothing is concatenated into a shell command.
    expect(args).toHaveLength(1);
    expect(args[0]).toBe(malicious);
  });

  it('selects the platform-correct opener', () => {
    expect(buildOpenCommand('/x/report.html', 'darwin').cmd).toBe('open');
    expect(buildOpenCommand('/x/report.html', 'linux').cmd).toBe('xdg-open');
    expect(buildOpenCommand('/x/report.html', 'win32').cmd).toBe('start');
  });

  it('passes an empty title before the path on Windows (start treats the first arg as a title)', () => {
    const { args } = buildOpenCommand('/c/path to/report.html', 'win32');
    expect(args[0]).toBe('');
    expect(args[1]).toBe('/c/path to/report.html');
  });
});
