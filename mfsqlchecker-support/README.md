# mfsqlchecker-support README

This extension adds integration of [mfsqlchecker](https://github.com/MedFlyt/mfsqlchecker) for Visual Studio Code.

## Features

* Validate that all SQL queries are valid
* Auto-fix returned column types

## Requirements

Make sure that your project has a dependency on [mfsqlchecker](https://www.npmjs.com/package/mfsqlchecker)

Your project must contain a `mfsqlchecker.json` file.

## Extension Settings

This extension contributes the following settings:

* `myExtension.enable`: enable/disable this extension
* `myExtension.thing`: set to `blah` to do something

## Known Issues

None yet

## Publishing a new Version of the Extension to Visual Studio Marketplace

Edit the package.json file to increment the "version"

Get a "Personal Access Token" from: <https://dev.azure.com/MedFlyt/_usersSettings/tokens>

    $ git clone ...
    $ cd mfsqlchecker/mfsqlchecker-support
    $ npm install
    $ ./node_modules/.bin/vsce publish
