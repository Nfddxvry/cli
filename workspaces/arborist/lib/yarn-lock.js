// parse a yarn lock file
// basic format
//
// <request spec>[, <request spec> ...]:
//   <key> <value>
//   <subkey>:
//     <key> <value>
//
// Assume that any key or value might be quoted, though that's only done
// in practice if certain chars are in the string. When writing back, we follow
// Yarn's rules for quoting, to cause minimal friction.
//
// The data format would support nested objects, but at this time, it
// appears that yarn does not use that for anything, so in the interest
// of a simpler parser algorithm, this implementation only supports a
// single layer of sub objects.
//
// This doesn't deterministically define the shape of the tree, and so
// cannot be used (on its own) for Arborist.loadVirtual.
// But it can give us resolved, integrity, and version, which is useful
// for Arborist.loadActual and for building the ideal tree.
//
// At the very least, when a yarn.lock file is present, we update it
// along the way, and save it back in Shrinkwrap.save()
//
// NIHing this rather than using @yarnpkg/lockfile because that module
// is an impenetrable 10kloc of webpack flow output, which is overkill
// for something relatively simple and tailored to Arborist's use case.

const localeCompare = require('@isaacs/string-locale-compare')('en')
const consistentResolve = require('./consistent-resolve.js')
const { dirname } = require('node:path')
const { breadth } = require('treeverse')

// Sort Yarn entries respecting the yarn.lock sort order
const yarnEntryPriorities = {
  name: 1,
  version: 2,
  uid: 3,
  resolved: 4,
  integrity: 5,
  registry: 6,
  dependencies: 7,
}

const priorityThenLocaleCompare = (a, b) => {
  if (!yarnEntryPriorities[a] && !yarnEntryPriorities[b]) {
    return localeCompare(a, b)
  }
  /* istanbul ignore next */
  return (yarnEntryPriorities[a] || 100) > (yarnEntryPriorities[b] || 100) ? 1 : -1
}

const quoteIfNeeded = val => {
  if (
    typeof val === 'boolean' ||
    typeof val === 'number' ||
    val.startsWith('true') ||
    val.startsWith('false') ||
    /[:\s\n\\",[\]]/g.test(val) ||
    !/^[a-zA-Z]/g.test(val)
  ) {
    return JSON.stringify(val)
  }

  return val
}

// sort a key/value object into a string of JSON stringified keys and vals
const sortKV = obj => Object.keys(obj)
  .sort(localeCompare)
  .map(k => `    ${quoteIfNeeded(k)} ${quoteIfNeeded(obj[k])}`)
  .join('\n')

// for checking against previous entries
const match = (p, n) =>
  p.integrity && n.integrity ? p.integrity === n.integrity
  : p.resolved && n.resolved ? p.resolved === n.resolved
  : p.version && n.version ? p.version === n.version
  : true

const prefix =
`# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


`

const nullSymbol = Symbol('null')
class YarnLock {
  static parse (data) {
    return new YarnLock().parse(data)
  }

  static fromTree (tree) {
    return new YarnLock().fromTree(tree)
  }

  constructor () {
    this.entries = null
    this.endCurrent()
  }

  endCurrent () {
    this.current = null
    this.subkey = nullSymbol
  }

  parse (data) {
    const ENTRY_START = /^[^\s].*:$/
    const SUBKEY = /^ {2}[^\s]+:$/
    const SUBVAL = /^ {4}[^\s]+ .+$/
    const METADATA = /^ {2}[^\s]+ .+$/
    this.entries = new Map()
    this.current = null
    const linere = /([^\r\n]*)\r?\n/gm
    let match
    let lineNum = 0
    if (!/\n$/.test(data)) {
      data += '\n'
    }
    while (match = linere.exec(data)) {
      const line = match[1]
      lineNum++
      if (line.charAt(0) === '#') {
        continue
      }
      if (line === '') {
        this.endCurrent()
        continue
      }
      if (ENTRY_START.test(line)) {
        this.endCurrent()
        const specs = this.splitQuoted(line.slice(0, -1), /, */)
        this.current = new YarnLockEntry(specs)
        specs.forEach(spec => this.entries.set(spec, this.current))
        continue
      }
      if (SUBKEY.test(line)) {
        this.subkey = line.slice(2, -1)
        this.current[this.subkey] = {}
        continue
      }
      if (SUBVAL.test(line) && this.current && this.current[this.subkey]) {
        const subval = this.splitQuoted(line.trimLeft(), ' ')
        if (subval.length === 2) {
          this.current[this.subkey][subval[0]] = subval[1]
          continue
        }
      }
      // any other metadata
      if (METADATA.test(line) && this.current) {
        const metadata = this.splitQuoted(line.trimLeft(), ' ')
        if (metadata.length === 2) {
          // strip off the legacy shasum hashes
          if (metadata[0] === 'resolved') {
            metadata[1] = metadata[1].replace(/#.*/, '')
          }
          this.current[metadata[0]] = metadata[1]
          continue
        }
      }

      throw Object.assign(new Error('invalid or corrupted yarn.lock file'), {
        position: match.index,
        content: match[0],
        line: lineNum,
      })
    }
    this.endCurrent()
    return this
  }

  splitQuoted (str, delim) {
    // a,"b,c",d"e,f => ['a','"b','c"','d"e','f'] => ['a','b,c','d"e','f']
    const split = str.split(delim)
    const out = []
    let o = 0
    for (let i = 0; i < split.length; i++) {
      const chunk = split[i]
      if (/^".*"$/.test(chunk)) {
        out[o++] = chunk.trim().slice(1, -1)
      } else if (/^"/.test(chunk)) {
        let collect = chunk.trimLeft().slice(1)
        while (++i < split.length) {
          const n = split[i]
          // something that is not a slash, followed by an even number
          // of slashes then a " then end => ending on an unescaped "
          if (/[^\\](\\\\)*"$/.test(n)) {
            collect += n.trimRight().slice(0, -1)
            break
          } else {
            collect += n
          }
        }
        out[o++] = collect
      } else {
        out[o++] = chunk.trim()
      }
    }
    return out
  }

  toString () {
    return prefix + [...new Set([...this.entries.values()])]
      .map(e => e.toString())
      .sort((a, b) => localeCompare(a.replace(/"/g, ''), b.replace(/"/g, ''))).join('\n\n') + '\n'
  }

  fromTree (tree) {
    this.entries = new Map()
    // walk the tree in a deterministic order, breadth-first, alphabetical
    breadth({
      tree,
      visit: node => this.addEntryFromNode(node),
      getChildren: node => [...node.children.values(), ...node.fsChildren]
        .sort((a, b) => a.depth - b.depth || localeCompare(a.name, b.name)),
    })
    return this
  }

  addEntryFromNode (node) {
    const specs = [...node.edgesIn]
      .map(e => `${node.name}@${e.spec}`)
      .sort(localeCompare)

    // Note:
    // yarn will do excessive duplication in a case like this:
    // root -> (x@1.x, y@1.x, z@1.x)
    // y@1.x -> (x@1.1, z@2.x)
    // z@1.x -> ()
    // z@2.x -> (x@1.x)
    //
    // where x@1.2 exists, because the "x@1.x" spec will *always* resolve
    // to x@1.2, which doesn't work for y's dep on x@1.1, so you'll get this:
    //
    // root
    // +-- x@1.2.0
    // +-- y
    // |   +-- x@1.1.0
    // |   +-- z@2
    // |       +-- x@1.2.0
    // +-- z@1
    //
    // instead of this more deduped tree that arborist builds by default:
    //
    // root
    // +-- x@1.2.0 (dep is x@1.x, from root)
    // +-- y
    // |   +-- x@1.1.0
    // |   +-- z@2 (dep on x@1.x deduped to x@1.1.0 under y)
    // +-- z@1
    //
    // In order to not create an invalid yarn.lock file with conflicting
    // entries, AND not tell yarn to create an invalid tree, we need to
    // ignore the x@1.x spec coming from z, since it's already in the entries.
    //
    // So, if the integrity and resolved don't match a previous entry, skip it.
    // We call this method on shallower nodes first, so this is fine.
    const n = this.entryDataFromNode(node)
    let priorEntry = null
    const newSpecs = []
    for (const s of specs) {
      const prev = this.entries.get(s)
      // no previous entry for this spec at all, so it's new
      if (!prev) {
        // if we saw a match already, then assign this spec to it as well
        if (priorEntry) {
          priorEntry.addSpec(s)
        } else {
          newSpecs.push(s)
        }
        continue
      }

      const m = match(prev, n)
      // there was a prior entry, but a different thing.  skip this one
      if (!m) {
        continue
      }

      // previous matches, but first time seeing it, so already has this spec.
      // go ahead and add all the previously unseen specs, though
      if (!priorEntry) {
        priorEntry = prev
        for (const s of newSpecs) {
          priorEntry.addSpec(s)
          this.entries.set(s, priorEntry)
        }
        newSpecs.length = 0
        continue
      }

      // have a prior entry matching n, and matching the prev we just saw
      // add the spec to it
      priorEntry.addSpec(s)
      this.entries.set(s, priorEntry)
    }

    // if we never found a matching prior, then this is a whole new thing
    if (!priorEntry) {
      const entry = Object.assign(new YarnLockEntry(newSpecs), n)
      for (const s of newSpecs) {
        this.entries.set(s, entry)
      }
    } else {
      // pick up any new info that we got for this node, so that we can
      // decorate with integrity/resolved/etc.
      Object.assign(priorEntry, n)
    }
  }

  entryDataFromNode (node) {
    const n = {}
    if (node.package.dependencies) {
      n.dependencies = node.package.dependencies
    }
    if (node.package.optionalDependencies) {
      n.optionalDependencies = node.package.optionalDependencies
    }
    if (node.version) {
      n.version = node.version
    }
    if (node.resolved) {
      n.resolved = consistentResolve(
        node.resolved,
        node.isLink ? dirname(node.path) : node.path,
        node.root.path,
        true
      )
    }
    if (node.integrity) {
      n.integrity = node.integrity
    }

    return n
  }

  static get Entry () {
    return YarnLockEntry
  }
}

class YarnLockEntry {
  #specs
  constructor (specs) {
    this.#specs = new Set(specs)
    this.resolved = null
    this.version = null
    this.integrity = null
    this.dependencies = null
    this.optionalDependencies = null
  }

  toString () {
    // sort objects to the bottom, then alphabetical
    return ([...this.#specs]
      .sort(localeCompare)
      .map(quoteIfNeeded).join(', ') +
      ':\n' +
      Object.getOwnPropertyNames(this)
        .filter(prop => this[prop] !== null)
        .sort(priorityThenLocaleCompare)
        .map(prop =>
          typeof this[prop] !== 'object'
            ? `  ${prop} ${prop === 'integrity' ? this[prop] : JSON.stringify(this[prop])}\n`
            : Object.keys(this[prop]).length === 0 ? ''
            : `  ${prop}:\n` + sortKV(this[prop]) + '\n')
        .join('')).trim()
  }

  addSpec (spec) {
    this.#specs.add(spec)
  }
}

module.exports = YarnLock
