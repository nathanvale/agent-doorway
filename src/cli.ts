import { runProcess } from "agent-cli-kernel";
import { createDoorway } from "./commands.ts";

const doorway = createDoorway(process.env, ["state", "programs"]);

await runProcess(doorway.contract, doorway.setup)(process.argv.slice(2));
