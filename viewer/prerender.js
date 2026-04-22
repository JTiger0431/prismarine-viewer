const path = require('path')
const os = require('os')
const cp = require('child_process')
const { makeTextureAtlas } = require('./lib/atlas')
const { prepareBlocksStates } = require('./lib/modelsBuilder')
const mcAssets = require('minecraft-assets')
const mcData = require('minecraft-data')
const fs = require('fs-extra')

const texturesPath = path.resolve(__dirname, '../public/textures')
if (fs.existsSync(texturesPath) && !process.argv.includes('-f')) {
  console.log('textures folder already exists, skipping...')
  process.exit(0)
}
fs.mkdirSync(texturesPath, { recursive: true })

const blockStatesPath = path.resolve(__dirname, '../public/blocksStates')
fs.mkdirSync(blockStatesPath, { recursive: true })

const supportedVersions = require('./lib/version').supportedVersions

const mojangCacheDir = path.join(os.tmpdir(), 'prismarine-viewer-mojang-cache')
fs.mkdirSync(mojangCacheDir, { recursive: true })

function readJsonFromJar (jarPath, filePath) {
  try {
    const content = cp.execFileSync('unzip', ['-p', jarPath, filePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return JSON.parse(content)
  } catch (err) {
    return null
  }
}

function normalizeModelPath (modelName) {
  let normalized = modelName
  if (normalized.startsWith('minecraft:')) normalized = normalized.slice('minecraft:'.length)
  return normalized
}

function modelKeyFromPath (modelPath) {
  return modelPath.split('/').pop()
}

function normalizeTexturePath (textureName) {
  let normalized = textureName
  if (normalized.startsWith('minecraft:')) normalized = normalized.slice('minecraft:'.length)
  return normalized
}

function ensureTextureFromJar (assets, jarPath, texturePath) {
  const normalized = normalizeTexturePath(texturePath)
  if (!normalized.startsWith('block/')) return
  const textureName = normalized.slice('block/'.length)
  const outputPath = path.join(assets.directory, 'blocks', textureName + '.png')
  if (fs.existsSync(outputPath)) return

  try {
    const buf = cp.execFileSync('unzip', ['-p', jarPath, `assets/minecraft/textures/${normalized}.png`], { stdio: ['ignore', 'pipe', 'ignore'] })
    fs.writeFileSync(outputPath, buf)
  } catch (err) {
    console.warn(`Unable to load texture ${normalized} from ${jarPath}`)
  }
}

function collectModelsFromState (state) {
  const models = new Set()
  if (state.variants) {
    for (const variant of Object.values(state.variants)) {
      if (variant instanceof Array) {
        for (const v of variant) {
          if (v.model) models.add(v.model)
        }
      } else if (variant.model) {
        models.add(variant.model)
      }
    }
  }
  if (state.multipart) {
    for (const part of state.multipart) {
      if (part.apply instanceof Array) {
        for (const v of part.apply) {
          if (v.model) models.add(v.model)
        }
      } else if (part.apply?.model) {
        models.add(part.apply.model)
      }
    }
  }
  return [...models]
}

function ensureModelFromJar (assets, jarPath, modelName, seen = new Set()) {
  const normalizedModelPath = normalizeModelPath(modelName)
  const modelKey = modelKeyFromPath(normalizedModelPath)
  if (seen.has(modelKey) || assets.blocksModels[modelKey]) return
  seen.add(modelKey)

  const model = readJsonFromJar(jarPath, `assets/minecraft/models/${normalizedModelPath}.json`)
  if (!model) return
  assets.blocksModels[modelKey] = model

  if (model.parent) ensureModelFromJar(assets, jarPath, model.parent, seen)
  if (model.textures) {
    for (const texture of Object.values(model.textures)) {
      if (texture.startsWith('#')) continue
      ensureTextureFromJar(assets, jarPath, texture)
    }
  }
}

function ensureMojangClientJar (version) {
  const manifestPath = path.join(mojangCacheDir, 'version_manifest_v2.json')
  cp.execFileSync('curl', ['-fsSL', '-o', manifestPath, 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'])
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const versionData = manifest.versions.find(v => v.id === version)
  if (!versionData) return null

  const versionMetaPath = path.join(mojangCacheDir, `${version}.json`)
  cp.execFileSync('curl', ['-fsSL', '-o', versionMetaPath, versionData.url])
  const versionMeta = JSON.parse(fs.readFileSync(versionMetaPath, 'utf8'))
  const jarPath = path.join(mojangCacheDir, `${version}.jar`)
  if (!fs.existsSync(jarPath)) {
    cp.execFileSync('curl', ['-fsSL', '-o', jarPath, versionMeta.downloads.client.url], { stdio: 'inherit' })
  }
  return jarPath
}

function hydrateMissingAssetsFromMojang (version, assets) {
  const knownBlocks = mcData(version).blocksArray
  const missingBlockStates = knownBlocks.filter(block => !assets.blocksStates[block.name]).map(block => block.name)
  if (missingBlockStates.length === 0) return

  console.log(`[${version}] Missing ${missingBlockStates.length} block states in minecraft-assets, hydrating from Mojang client jar...`)
  const jarPath = ensureMojangClientJar(version)
  if (!jarPath) {
    console.warn(`[${version}] Unable to find Mojang version metadata, skipping hydration.`)
    return
  }

  for (const blockName of missingBlockStates) {
    const state = readJsonFromJar(jarPath, `assets/minecraft/blockstates/${blockName}.json`)
    if (!state) continue

    assets.blocksStates[blockName] = state
    for (const model of collectModelsFromState(state)) {
      ensureModelFromJar(assets, jarPath, model)
    }
  }
}

for (const version of supportedVersions) {
  const assets = mcAssets(version)
  hydrateMissingAssetsFromMojang(version, assets)
  const atlas = makeTextureAtlas(assets)
  const out = fs.createWriteStream(path.resolve(texturesPath, version + '.png'))
  const stream = atlas.canvas.pngStream()
  stream.on('data', (chunk) => out.write(chunk))
  stream.on('end', () => console.log('Generated textures/' + version + '.png'))

  const blocksStates = JSON.stringify(prepareBlocksStates(assets, atlas))
  fs.writeFileSync(path.resolve(blockStatesPath, version + '.json'), blocksStates)

  fs.copySync(assets.directory, path.resolve(texturesPath, version), { overwrite: true })
}
