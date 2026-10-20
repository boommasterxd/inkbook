import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function markdownFiles(root, directory = "docs") {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await markdownFiles(root, path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files.sort();
}

function checkFences(content, file) {
  let fence;
  const prose = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!match) {
      if (!fence) prose.push(line);
      continue;
    }
    const marker = match[1];
    if (!fence) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length && !match[2].trim())
      fence = undefined;
  }
  if (fence) throw new Error(`Unclosed Markdown fence: ${file}`);
  return prose.join("\n").replace(/(`+)[\s\S]*?\1/g, "");
}

async function checkLinks(root, file, content) {
  for (const match of content.matchAll(/\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].split(/[?#]/)[0];
    if (!target || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) continue;
    try {
      await access(resolve(root, dirname(file), decodeURIComponent(target)));
    } catch {
      throw new Error(`Broken relative Markdown link in ${file}: ${target}`);
    }
  }
}

export async function validateDocumentation(root) {
  const files = await markdownFiles(root);
  const instructions = await readFile(join(root, "AGENTS.md"), "utf8");
  const index = instructions.split("## Documentation Index\n")[1]?.split(/\n## /)[0];
  if (index === undefined) throw new Error("Missing Documentation Index.");
  const indexed = [...index.matchAll(/\]\((docs\/[^)]+\.md)\)/g)].map((match) => match[1]);
  if (JSON.stringify(indexed) !== JSON.stringify(files)) {
    throw new Error("Documentation Index must list every document exactly once in path order.");
  }
  for (const file of [...files, "AGENTS.md", "README.md"]) {
    const content = await readFile(join(root, file), "utf8");
    await checkLinks(root, file, checkFences(content, file));
  }
  process.stdout.write(`Validated ${files.length} indexed documents and root documentation.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await validateDocumentation(process.cwd());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
