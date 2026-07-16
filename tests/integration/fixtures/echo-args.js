// Echo-args fixture: prints the argv it received (after `node <this>`) as JSON,
// so tests can assert that special-character arguments survive the passthrough
// quoting instead of being interpreted by cmd.exe (injection/mangling).
process.stdout.write("ARGV:" + JSON.stringify(process.argv.slice(2)) + "\n");
process.exit(0);
