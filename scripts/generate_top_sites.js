const fs = require("node:fs");
const path = require("node:path");

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/generate_top_sites.js top-sites.csv");
const domains = fs.readFileSync(input, "utf8").trim().split(/\r?\n/).slice(0, 10000).map(line => line.split(",").at(-1).trim().toLowerCase()).filter(Boolean);
if (domains.length !== 10000) throw new Error(`Expected 10000 domains, received ${domains.length}.`);
const output = `// Generated from the Tranco daily top-sites list: https://tranco-list.eu/\n(function(root){root.OrganizerTopSites=${JSON.stringify(domains)};})(typeof globalThis!=="undefined"?globalThis:this);\n`;
fs.writeFileSync(path.resolve(__dirname, "../shared/top-sites.js"), output);
console.log(`Generated ${domains.length} top domains.`);
