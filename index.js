const {launch} = require("puppeteer");
const yargs = require("yargs")

const {download, turnSpec, awaitSync} = require("./util.jsx")

let {argv: {_: argv, bulk = true, headless = true, ...global_opts}} = replayArgs(process.argv.slice(2))
    //.parserConfiguration({"unknown-options-as-args": true})
    .option('bulk', {
        alias: 'b',
        describe: "How many instances to run at once, if giving more than one argument",
    })
    .boolean('headless')

// options configurable per replay. also configurable globally
function replayArgs(argv) {
    return yargs(argv)
        .option("reverse", {
            alias: 'r',
            describe: 'reverse',
            type: 'boolean',
            //default: false,
        })
        .option('show', {choices: [false, 'teams', "chat"],})
        .option("gif", {
            describe: "generate a gif with this input",
            type: 'boolean',
            //default: true,
        })
        .option("speed",
            {
                describe: 'factor to speed up output. does not speed up generation',
                //default: 1,
                type: "number",
            })
        .option('fast',
            {
                describe: 'Speed up output by duration of messages and minor animations are active',
                //default: false,
                type: 'boolean',
            })
}

const browser = launch({headless});

// split parts into sections
const parts = function () {
    let result = [];
    let last = 0;
    for (let i = last; i <= argv.length; i++) {
        // todo find a clean way to split args
        if (i === argv.length || argv[i] === ':' || argv[i] === '\n') {
            let slice = argv.slice(last, i)
            last = i + 1
            if (!slice) continue
            const {argv: {_: [src, turnData], ...opts}} = replayArgs(slice);
            if (src && !turnData && turnSpec.test(src)) {
                if (result) {
                    // use the previous one
                    // currently this will just redo the whole thing, but in the future...maybe
                    result.push({...result.at(-1), turnData: src, ...opts})
                } else throw Error("No src provided!")
            } else result.push({...global_opts, src, turnData, ...opts})
        }
    }
    return result
}()


// parallelism check
let actions = parts.map((value,) => async () => download({browser, ...value}))
let n = parts.length === 1 || (bulk || bulk === 1) && (bulk >= parts.length || bulk === true ? true : Math.ceil(parts.length / bulk));
(!n ? awaitSync(actions)
    : Promise.all(
        n === true ? actions.map(it => it()) :
            function () {
                // map into buckets, todo improve algorithm
                let res = []
                let i = 0;
                while (i < n) res.push(awaitSync(actions.slice(n * i, n * ++i)))
                return res;
            }()
    )).then(() => browser.then(b => b.close()))