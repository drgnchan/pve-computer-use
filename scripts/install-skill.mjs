#!/usr/bin/env node
// Installs (and validates) this project's SKILL.md into a Pi skills directory.
// Copies are used instead of symlinks because Pi's discovery may not follow
// them; re-run this after editing SKILL.md so the copies cannot drift.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'SKILL.md');

const args = process.argv.slice(2);
const globalInstall = args.includes('--global');
const destArg = args.find(arg => arg.startsWith('--dest='))?.slice('--dest='.length);

function validate(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter');
  const frontmatter = match[1];
  const name = /^name:[ \t]*(.+)$/m.exec(frontmatter)?.[1].trim();
  const description = /^description:[ \t]*([\s\S]*?)(?=\r?\n[a-z-]+:|$)/m.exec(frontmatter)?.[1].trim();

  if (!name) throw new Error('frontmatter is missing name');
  if (name.length > 64) throw new Error('skill name exceeds 64 characters');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`invalid skill name "${name}": lowercase letters, digits and single hyphens only`);
  if (!description) throw new Error('frontmatter is missing description; Pi would not load the skill');
  if (description.length > 1024) throw new Error(`description is ${description.length} characters, the limit is 1024`);
  return { name, descriptionLength: description.length };
}

function workspaceSkillsDir() {
  let dir = root;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, '.agents', 'skills');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.dirname(root), '.agents', 'skills');
}

const text = fs.readFileSync(source, 'utf8');
const { name, descriptionLength } = validate(text);

const targets = [destArg ? path.resolve(destArg) : workspaceSkillsDir()];
if (globalInstall) targets.push(path.join(os.homedir(), '.agents', 'skills'));

for (const base of targets) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, 'SKILL.md');
  fs.copyFileSync(source, destination);
  const identical = fs.readFileSync(destination, 'utf8') === text;
  console.log(`${identical ? 'installed' : 'MISMATCH'} ${destination}`);
  if (!identical) process.exitCode = 1;
}

console.log(`skill "${name}" validated (description ${descriptionLength} chars)`);
