import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { registerIoTests } from "./cache-lifecycle/io.cjs";
import recovery from "./cache-lifecycle/recovery.cjs";
import { registerTests, registerTransportTests } from "./cache-lifecycle/register.cjs";

const directory = fileURLToPath(new URL("../../../scripts/cache-lifecycle/", import.meta.url));
registerTests(test, assert, directory);
registerTransportTests(test, assert, directory);
recovery.registerRecoveryTests(test, assert, directory);
registerIoTests(test, assert, directory);
