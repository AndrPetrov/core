const core = require("./lib/index.js")

const dryRun = async () => {
    await core.startup()
    process.exit(0)
}

dryRun()
