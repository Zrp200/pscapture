# Replay To Gif

A Node.js application to make gifs out of notable moments in a battle 

Inspired by [Intenzi/ShowdownReplayDownloader](https://github.com/Intenzi/ShowdownReplayDownloader)

Currently, it will make two directories in the working directory for outputs. This will probably be configurable in the future.

## Usage:
```replaytogif [<src> [[range] [replay_opts]]..```

### Positionals:
#### src 
Link to the replay. The "https://play.pokemonshowdown" is optional.

This must be the first positional given, but it can be given again to generate clips from different replays in the same command

#### range
Turn range to capture, of the form `begin-end`

both `begin` and `end` can be omitted; `begin` defaults to the start of the battle, `end` defaults to the end of it.

Steps can also be provided to provide more control over what to capture. For example, `4move-faint` would start at turn 4 at the first move. The steps are found by matching the start of the current step, so `move` would match any step starting with`|move`

If only `begin` is given, (turns=6, for example) `end` is assumed to be the same turn, and the gif will cover only that turn.

### Replay Options
#### -r, --reverse
reverse viewpoint of battle
#### --player, --side
viewpoint to use for battle

mutually exclusive with reverse
#### --show
Show chat or teams (the sidebars) and/or chat. Default is to hide these.

choices: false, "teams" (show chat and teams, enables nicknames), "chat" (show chat)

default: false (show only the main battle)
#### --speed
adjust time between messages. affects output speed.

hyperfast disables animations

choices: "very slow", "slow", "normal", "fast", "hyperfast"
default: "normal"
#### --vspeed
output video speed

#### --gen
Takes a number. Override the sprite generation

#### --hardcore
hide extra information not present in game

#### --turns
Show the turn indicator, default true

#### --gif
generate a gif with this input, default true

#### --open
open the gif/webm after generation

### Options:
#### --help                
Show help
#### --version             
Show version number
#### -b, --bulk
How many instances to run at once, if giving more than one argument
#### --headless                                       
hide browsers windows. default true.
