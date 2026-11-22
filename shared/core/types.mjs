/**
 * @typedef {object} SyncConfig
 * @property {boolean} enabled
 * @property {'lan'|'remote'} mode
 * @property {boolean} auto
 * @property {boolean|null} wifiOnly
 * @property {boolean} listen
 * @property {number} port
 * @property {string} remoteUrl
 * @property {string} remoteUser
 * @property {string} branch
 * @property {string} name
 * @property {string} email
 * @property {string} peerUrl
 * @property {string} peerVaultId
 * @property {string} peerName
 * @property {string[]} endpoints
 * @property {string} deviceName
 */

/**
 * @typedef {object} ConflictItem
 * @property {string} path
 * @property {string|null} [copy]
 */

/**
 * @typedef {object} VaultRecord
 * @property {SyncConfig} settings
 * @property {string} vaultId
 * @property {string|null} [lastSynced]
 * @property {number} [lastSyncedAt]
 * @property {{url: string, branch: string, head: string|null}} [remoteSync]
 * @property {ConflictItem[]} conflicts
 * @property {{pat?: string, peer?: string, lan?: string}} [encrypted]
 */

/**
 * @typedef {object} WikilinkRef
 * @property {string} target
 * @property {string} heading
 * @property {string} alias
 * @property {boolean} embedded
 * @property {number} line
 */

/**
 * @typedef {object} IndexedReference
 * @property {string} dest
 * @property {boolean} wiki
 * @property {number} line
 * @property {string} text
 * @property {number} from
 * @property {boolean} [embedded]
 * @property {[number, number]|null} mark
 */

/**
 * @typedef {object} IndexEntry
 * @property {string} path
 * @property {string} relative
 * @property {number} mtime
 * @property {number} size
 * @property {string} title
 * @property {{text: string, level: number, line: number}[]} headings
 * @property {string[]} tags
 * @property {Record<string, unknown>} frontmatter
 * @property {Record<string, unknown>} values
 * @property {IndexedReference[]} links
 * @property {WikilinkRef[]} wikilinks
 * @property {{text: string, checked: boolean}[]} tasks
 * @property {string|null} text
 * @property {string[]|null} lines
 * @property {[number, string][]} mentions
 * @property {string} [hash]
 * @property {string} [signature]
 * @property {Map<string, IndexedReference[]>} [targets]
 * @property {Set<string>} [dependencies]
 */

/**
 * @typedef {object} PathOperations
 * @property {string} sep
 * @property {(...parts: string[]) => string} resolve
 * @property {(parent: string, child: string) => string} relative
 * @property {(path: string) => string} dirname
 * @property {(path: string) => string} basename
 */
export {};
