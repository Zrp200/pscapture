const {launch} = require("puppeteer");
const yargs = require("yargs")

const {download, turnSpec, awaitSync} = require("./util.jsx")


const browser = launch({headless: false});

let {argv: {_: argv, bulk}} = yargs(process.argv.slice(2))
    .parserConfiguration({"unknown-options-as-args": true})
    .option('bulk', {
        alias: 'b',
        describe: "How many instances to run at once, if giving more than one argument",
        default: true
    })

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
            const {argv: {_: [src, turnData], ...opts}} = yargs(slice)
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
                        describe: 'factor to speed up output',
                        //default: 1,
                        type: "number",
                    })
                .option("fadespeed",
                    {
                        describe: 'how fast messages go away. Standard "fast" would be 6. Speeds up output slightly.',
                        //default: 1,
                        type: "number",
                    })
            if (src && !turnData && turnSpec.test(src)) {
                if (result) {
                    // use the previous one
                    // currently this will just redo the whole thing, but in the future...maybe
                    result.push({...result.at(-1), turnData: src, ...opts})
                } else throw Error("No src provided!")
            } else result.push({src, turnData, ...opts})
        }
    }
    return result
}()




// parallelism check
let actions = parts.map((value, id) => async () => download({browser: await browser, id, ...value}))
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