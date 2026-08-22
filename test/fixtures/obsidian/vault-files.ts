import type { TFile, TFolder } from "obsidian";

export class FakeObsidianFile {
  readonly path: string;
  readonly stat = { ctime: 0, mtime: 0, size: 0 };

  constructor(path: string) {
    this.path = path;
  }
}

class FakeObsidianFolder {}

export const fakeObsidianFileClasses = {
  file: FakeObsidianFile as unknown as abstract new (...arguments_: never[]) => TFile,
  folder: FakeObsidianFolder as unknown as abstract new (...arguments_: never[]) => TFolder,
};
