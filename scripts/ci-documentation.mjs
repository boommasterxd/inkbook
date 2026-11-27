import { access, readFile, readdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
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
  return prose.join("\n");
}

function findAnchors(prose) {
  const anchors = new Set();
  for (const [, heading] of prose.matchAll(/^ {0,3}#{1,6} +(.+?) *(?: +#+)?$/gm)) {
    const slug = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/ /g, "-");
    let candidate = slug;
    for (let suffix = 1; anchors.has(candidate); suffix++) candidate = `${slug}-${suffix}`;
    anchors.add(candidate);
  }
  for (const [, anchor] of prose.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) {
    anchors.add(anchor);
  }
  return anchors;
}

async function validateLink(root, file, target, documents) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) return;
  const [location, fragment] = target.split("#", 2);
  const pathName = decodeURIComponent(location.split("?", 1)[0]);
  const destination = pathName === "" ? file : posix.join(posix.dirname(file), pathName);
  if (
    pathName.includes("\\") ||
    pathName.startsWith("/") ||
    destination === ".." ||
    destination.startsWith("../")
  ) {
    throw new Error(`Target lies outside the repository: ${destination}`);
  }
  const document = documents.get(destination);
  if (document === undefined) await access(resolve(root, destination));
  if (fragment && document !== undefined && !document.anchors.has(decodeURIComponent(fragment))) {
    throw new Error(`Missing heading or anchor: ${fragment}`);
  }
}

async function checkLinks(root, documents) {
  for (const [file, { prose }] of documents) {
    const markup = prose.replace(/(?<!`)(`+)(?!`)[^\n]*?\1(?!`)/g, "");
    const links = /\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)|\b(?:href|src)=["']([^"']+)["']/g;
    for (const match of markup.matchAll(links)) {
      const target = match[1] ?? match[2];
      try {
        await validateLink(root, file, target, documents);
      } catch (error) {
        throw new Error(`Broken relative documentation link in ${file}: ${target}`, {
          cause: error,
        });
      }
    }
  }
}

export async function validateDocumentation(root) {
  const files = await markdownFiles(root);
  const entry = await readFile(join(root, "docs/README.md"), "utf8");
  const index = entry.split("## Documentation Index\n")[1]?.split(/\n## /)[0];
  if (index === undefined) throw new Error("Missing Documentation Index.");
  const indexed = [...index.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) =>
    posix.join("docs", match[1]),
  );
  if (JSON.stringify(indexed) !== JSON.stringify(files)) {
    throw new Error("Documentation Index must list every document exactly once in path order.");
  }
  const documents = new Map();
  for (const file of [...files, "AGENTS.md", "README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    const content = await readFile(join(root, file), "utf8");
    const prose = checkFences(content, file);
    documents.set(file, { prose, anchors: findAnchors(prose) });
  }
  await checkLinks(root, documents);
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
