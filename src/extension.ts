'use strict';

/**
 * This file is part of the vscode-easy-coffeescript distribution.
 * Copyright (c) Marcel Joachim Kloubert.
 * 
 * vscode-easy-coffeescript is free software: you can redistribute it and/or modify  
 * it under the terms of the GNU Lesser General Public License as   
 * published by the Free Software Foundation, version 3.
 *
 * vscode-easy-coffeescript is distributed in the hope that it will be useful, but 
 * WITHOUT ANY WARRANTY; without even the implied warranty of 
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU 
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import * as _ from 'lodash';
const CoffeeScript = require('coffeescript');
import * as FSExtra from 'fs-extra';
const MergeDeep = require('merge-deep');
import * as Path from 'path';
import * as vscode from 'vscode';
import * as vscode_helpers from 'vscode-helpers';

interface CompilerResult {
    js: string;
    sourceMap?: any;
}

interface Config extends vscode.WorkspaceConfiguration {
    bare?: boolean;
    exclude?: string | string[];
    files?: string | string[];
    header?: boolean;    
    inlineMap?: boolean;
    options?: any;
    sourceMap?: boolean;
}

let isDeactivating = false;
let workspaceWatcher: vscode_helpers.WorkspaceWatcherContext<Workspace>;


class Workspace extends vscode_helpers.WorkspaceBase {
    private _isReloadingConfig = false;

    public config: Config;

    public get configSource(): vscode_helpers.WorkspaceConfigSource {
        return {
            resource: vscode.Uri.file(Path.join(
                this.rootPath,
                '.vscode',
                'settings.json'
            )),
            section: 'coffeescript.compile',
        };
    }

    public async initialize() {
        if (this.isInFinalizeState) {
            return;
        }

        await this.onDidChangeConfiguration();
    }    

    public isPathOf(path: string) {
        return false !== this.toFullPath(path);
    }

    public async onDidChangeConfiguration() {
        const ME = this;

        const MY_ARGS = arguments;

        if (ME._isReloadingConfig) {
            vscode_helpers.invokeAfter(async () => {
                await ME.onDidChangeConfiguration
                        .apply(ME, MY_ARGS);
            }, 1000);

            return;
        }

        ME._isReloadingConfig = true;
        try {
            let loadedCfg: Config = vscode.workspace.getConfiguration(ME.configSource.section,
                                                                      ME.configSource.resource) || <any>{};

            this.config = loadedCfg;
        }
        finally {
            ME._isReloadingConfig = false;
        }
    }

    public async onDidSaveTextDocument(e: vscode.TextDocument) {
        if (this.isInFinalizeState) {
            return;
        }

        const RELATIVE_PATH = this.toRelativePath(e.fileName);
        if (false === RELATIVE_PATH) {
            return;
        }

        if (this._isReloadingConfig) {
            return;
        }

        const CFG = this.config;
        if (!CFG) {
            return;
        }

        if (!vscode_helpers.toBooleanSafe(CFG.isActive, true)) {
            return;
        }

        const TO_MINIMATCH = (pattern: string) => {
            if (!pattern.trim().startsWith('/')) {
                pattern = '/' + pattern;
            }

            return pattern;
        };

        // files to include
        const FILES_TO_INCLUDE = vscode_helpers.asArray( CFG.files ).map(f => {
            return vscode_helpers.toStringSafe(f);
        }).filter(f => {
            return !vscode_helpers.isEmptyString(f);
        });
        if (FILES_TO_INCLUDE.length < 1) {
            FILES_TO_INCLUDE.push('**/*.coffee');
        }

        // files to exclude
        const EXCLUDE = vscode_helpers.asArray( CFG.exclude ).map(e => {
            return vscode_helpers.toStringSafe(e);
        }).filter(e => {
            return !vscode_helpers.isEmptyString(e);
        });

        const OPTS = {
            dot: true,
            nocase: true,
            nonull: false,
        };

        if (vscode_helpers.doesMatch(TO_MINIMATCH(RELATIVE_PATH), EXCLUDE.map(e => TO_MINIMATCH(e)), OPTS)) {
            return;  // excluded
        }

        if (!vscode_helpers.doesMatch(TO_MINIMATCH(RELATIVE_PATH), FILES_TO_INCLUDE.map(f => TO_MINIMATCH(f)), OPTS)) {
            return;  // not included
        }

        try {
            const FILE = Path.resolve( e.fileName );
            const FILE_DIR = Path.dirname( FILE );
            const FILE_NAME = Path.basename( FILE );
            const FILE_EXT = Path.extname( FILE );

            const OUT_FILE = Path.resolve(
                Path.join(
                    FILE_DIR,
                    Path.basename( FILE_NAME, FILE_EXT ) + '.js',
                )
            );
            const OUT_FILE_NAME = Path.basename( OUT_FILE );

            const SOURCE_MAP_FILE = Path.resolve(
                Path.join(
                    FILE_DIR,
                    OUT_FILE_NAME + '.map',
                )
            );
            const SOURCE_MAP_FILE_NAME = Path.basename( SOURCE_MAP_FILE );

            const CFG_OPTS = {
                bare: vscode_helpers.toBooleanSafe(CFG.bare),
                header: vscode_helpers.toBooleanSafe(CFG.header),
                inlineMap: vscode_helpers.toBooleanSafe(CFG.inlineMap),
                sourceMap: vscode_helpers.toBooleanSafe(CFG.sourceMap, true),                
            };

            let result: string | CompilerResult = CoffeeScript.compile((await FSExtra.readFile(FILE)).toString('utf8'),
                                                                       MergeDeep( CFG_OPTS, CFG.options ));

            if (_.isString(result)) {
                result = {
                    js: result,
                };
            }
            else {
                const SOURCE_MAP = result.sourceMap;
                if (SOURCE_MAP) {
                    const GENERATED_MAP = SOURCE_MAP.generate({
                        generatedFile: OUT_FILE_NAME,
                        sourceFiles: [
                            FILE_NAME
                        ]
                    });
                    if (GENERATED_MAP) {
                        // write source map
                        await FSExtra.writeFile(SOURCE_MAP_FILE,
                                                new Buffer(JSON.stringify(GENERATED_MAP), 'utf8'));
                    }
                }
            }

            let js = vscode_helpers.toStringSafe( result.js );
            if (!CFG_OPTS.inlineMap && CFG_OPTS.sourceMap) {
                js += `

//# sourceMappingURL=${ SOURCE_MAP_FILE_NAME }
//# sourceURL=coffeescript`;
            }
            
            // write JavaScript file
            await FSExtra.writeFile(OUT_FILE,
                                    new Buffer(js, 'utf8'));
        }
        catch (e) {
            vscode.window.showErrorMessage(
                `[CoffeeScript] ${ vscode_helpers.toStringSafe(e) }`
            );
        }
    }

    protected onDispose() {
    }

    public get rootPath() {
        return Path.resolve(
            this.folder.uri.fsPath
        );
    }

    public toFullPath(path: string): string | false {
        const RELATIVE_PATH = this.toRelativePath(path);
        if (false === RELATIVE_PATH) {
            return false;
        }

        return Path.resolve(
            Path.join(
                this.rootPath,
                RELATIVE_PATH
            )
        );
    }

    public toRelativePath(path: string): string | false {
        path = vscode_helpers.toStringSafe(path);

        path = replaceAllStrings(
            Path.resolve(path),
            Path.sep,
            '/'
        );

        const WORKSPACE_DIR = replaceAllStrings(
            this.rootPath,
            Path.sep,
            '/'
        );

        if (!path.startsWith(WORKSPACE_DIR)) {
            return false;
        }

        let relativePath = path.substr(WORKSPACE_DIR.length);
        while (relativePath.startsWith('/')) {
            relativePath = relativePath.substr(1);
        }
        while (relativePath.endsWith('/')) {
            relativePath = relativePath.substr(0, relativePath.length - 1);
        }

        return relativePath;
    }
}


async function onDidSaveTextDocument(e: vscode.TextDocument) {
    if (isDeactivating) {
        return;
    }

    try {
        for (const WS of workspaceWatcher.workspaces) {
            try {
                if (WS.isPathOf(e.fileName)) {
                    await WS.onDidSaveTextDocument(e);
                }
            }
            catch { }
        }
    }
    catch { }
}

function replaceAllStrings(str: string, searchValue: string, replaceValue: string) {
    str = vscode_helpers.toStringSafe(str);
    searchValue = vscode_helpers.toStringSafe(searchValue);
    replaceValue = vscode_helpers.toStringSafe(replaceValue);

    return str.split(searchValue)
              .join(replaceValue);
}

export async function activate(context: vscode.ExtensionContext) {
    const WF = vscode_helpers.buildWorkflow();

    // workspace watcher
    WF.next(async () => {
        context.subscriptions.push(
            workspaceWatcher = vscode_helpers.registerWorkspaceWatcher<Workspace>(context, async (ev: vscode_helpers.WorkspaceWatcherEvent, folder: vscode.WorkspaceFolder) => {
                switch (ev) {
                    case vscode_helpers.WorkspaceWatcherEvent.Added:
                        let newWorkspace: Workspace;
                        {
                            newWorkspace = new Workspace(folder);

                            await newWorkspace.initialize();
                        }
                        return newWorkspace;
                }
            }),
        );

        await workspaceWatcher.reload();
    });

    // save document
    WF.next(() => {
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument((e) => {
                onDidSaveTextDocument(e).then(() => {                    
                }, () => {                    
                });
            }),
        );
    });

    if (!isDeactivating) {
        await WF.start();
    }
}

export async function deactivate() {
    if (isDeactivating) {
        return;
    }
    isDeactivating = true;

    //TODO
}
