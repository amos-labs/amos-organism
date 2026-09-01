const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `amos-organism requires Node.js 22.18 or newer; found ${process.versions.node}. `
      + "Use the repository's pinned Node 24 runtime.",
  );
  process.exit(1);
}
