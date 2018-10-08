const Signal = require('signals')
const random = require('pex-random')
const vec3 = require('pex-math/vec3')
const mat4 = require('pex-math/mat4')
const utils = require('pex-math/utils')
const flatten = require('flatten')

const POSTPROCESS_VERT = require('./glsl/Postprocess.vert.js')
const COPY_FRAG = require('./glsl/Copy.frag.js')
const POSTPROCESS_FRAG = require('./glsl/Postprocess.frag.js')

const SAO_FRAG = require('./glsl/SAO.frag.js')
const BILATERAL_BLUR_FRAG = require('./glsl/BilateralBlur.frag.js')
const THRESHOLD_FRAG = require('./glsl/Threshold.frag.js')
const BLOOM_FRAG = require('./glsl/Bloom.frag.js')

const SMAA_BLEND_VERT = require('./glsl/lib/glsl-smaa/smaa-blend.vert.js')
const SMAA_BLEND_FRAG = require('./glsl/lib/glsl-smaa/smaa-blend.frag.js')
const SMAA_WEIGHTS_VERT = require('./glsl/lib/glsl-smaa/smaa-weights.vert.js')
const SMAA_WEIGHTS_FRAG = require('./glsl/lib/glsl-smaa/smaa-weights.frag.js')
const EDGES_VERT = require('./glsl/lib/glsl-smaa/edges.vert.js')
const EDGES_COLOR_FRAG = require('./glsl/lib/glsl-smaa/edges-color.frag.js')
const SMAA_TEXTURES = require('./glsl/lib/glsl-smaa/textures.js')

var ssaoKernel = []
for (let i = 0; i < 64; i++) {
  var sample = [
    random.float() * 2 - 1,
    random.float() * 2 - 1,
    random.float(),
    1
  ]
  vec3.normalize(sample)
  var scale = random.float()
  scale = utils.lerp(0.1, 1.0, scale * scale)
  vec3.scale(sample, scale)
  ssaoKernel.push(sample)
}
var ssaoKernelData = new Float32Array(flatten(ssaoKernel))

var ssaoNoise = []
for (let j = 0; j < 128 * 128; j++) {
  let noiseSample = [
    random.float() * 2 - 1,
    random.float() * 2 - 1,
    0,
    1
  ]
  ssaoNoise.push(noiseSample)
}
var ssaoNoiseData = new Float32Array(flatten(ssaoNoise))


function Camera (opts) {
  const gl = opts.ctx.gl
  this.type = 'Camera'
  this.changed = new Signal()

  // camera
  this.fov = Math.PI / 4
  this.aspect = 1
  this.near = 0.1
  this.far = 100
  this.backgroundColor = [0, 0, 0, 1]
  this.projectionMatrix = mat4.perspective(mat4.create(), this.fov, this.aspect, this.near, this.far)
  this.viewMatrix = mat4.create()

  // postprocessing
  this.postprocess = true
  this.rgbm = false
  this.depthPrepass = true
  this.ssao = false
  this.ssaoIntensity = 5
  this.ssaoRadius = 12
  this.ssaoBias = 0.01
  this.ssaoBlurRadius = 2
  this.ssaoBlurSharpness = 10
  this.dof = false
  this.dofIterations = 1
  this.dofRange = 5
  this.dofRadius = 1
  this.dofDepth = 6.76
  this.exposure = 1
  this.fxaa = true
  this.smaa = false
  this.fog = false
  this.bloom = false
  this.bloomRadius = 1
  this.bloomThreshold = 1
  this.bloomIntensity = 1
  this.sunDispertion = 0.2
  this.sunIntensity = 0.1
  this.inscatteringCoeffs = [0.3, 0.3, 0.3]
  this.fogColor = [0.5, 0.5, 0.5]
  this.fogStart = 5
  this.fogDensity = 0.15
  this.sunPosition = [1, 1, 1]
  this.viewport = [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight]
  this._textures = []

  this.set(opts)

  this.initPostproces()
}

Camera.prototype.init = function (entity) {
  this.entity = entity
}

Camera.prototype.set = function (opts) {
  Object.assign(this, opts)

  if (opts.camera) {
    // const camera = this.camera = opts.camera
    // this.projectionMatrix = camera.projectionMatrix
    // this.viewMatrix = camera.viewMatrix
    // this.position = camera.position
    // this.target = this.target
    // this.up = camera.up
  }

  if (opts.aspect || opts.near || opts.far || opts.fov) {
    mat4.perspective(this.projectionMatrix, this.fov, this.aspect, this.near, this.far)
  }

  if (opts.viewport) {
    const viewport = opts.viewport
    const aspect = viewport[2] / viewport[3]
    if (this.aspect !== aspect) {
      this.set({ aspect: aspect })
    }
    this._textures.forEach((tex) => {
      const expectedWidth = Math.floor(viewport[2] * (tex.sizeScale || 1))
      const expectedHeight = Math.floor(viewport[3] * (tex.sizeScale || 1))
      if (tex.width !== expectedWidth || tex.height !== expectedHeight) {
        console.log('update texture size', tex.width, expectedWidth, tex.height, expectedHeight)
        this.ctx.update(tex, {
          width: expectedWidth,
          height: expectedHeight
        })
      }
    })
  }

  if (this.postprocess && this.ctx.capabilities.maxColorAttachments < 2) {
    this.postprocess = false
    console.log('pex-renderer', `disabling postprocess as MAX_COLOR_ATTACHMENTS=${opts.ctx.capabilities.maxColorAttachments}`)
    console.log('pex-renderer ctx', this.ctx.capabilities)
  }

  Object.keys(opts).forEach((prop) => this.changed.dispatch(prop))
}

Camera.prototype.initPostproces = function () {
  var ctx = this.ctx
  var fsqPositions = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  var fsqFaces = [[0, 1, 2], [0, 2, 3]]

  var W = this.viewport[2]
  var H = this.viewport[3]

  this._fsqMesh = {
    attributes: {
      aPosition: ctx.vertexBuffer(fsqPositions)
    },
    indices: ctx.indexBuffer(fsqFaces)
  }

  this._frameColorTex = ctx.texture2D({
    name: 'frameColorTex',
    width: W,
    height: H,
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear
  })

  this._frameEmissiveTex = ctx.texture2D({
    name: 'frameColorTex',
    width: W,
    height: H,
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear
  })

  this._frameNormalTex = ctx.texture2D({
    name: 'frameNormalTex',
    width: W,
    height: H,
    pixelFormat: ctx.PixelFormat.RGBA8,
    encoding: ctx.Encoding.Linear
  })

  this._frameDepthTex = ctx.texture2D({
    name: 'frameDepthTex',
    width: W,
    height: H,
    pixelFormat: ctx.PixelFormat.Depth,
    encoding: ctx.Encoding.Linear
  })

  this._frameAOTex = ctx.texture2D({ name: 'frameAOTex', width: W, height: H, pixelFormat: ctx.PixelFormat.RGBA8, encoding: ctx.Encoding.Linear })
  this._frameAOBlurTex = ctx.texture2D({ name: 'frameAOBlurTex', width: W, height: H, pixelFormat: ctx.PixelFormat.RGBA8, encoding: ctx.Encoding.Linear })
  this._frameDofBlurTex = ctx.texture2D({
    name: 'frameDofBlurTex',
    width: W,
    height: H,
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear
  })

  this._frameBloomHTex = ctx.texture2D({
    name: 'frameBloomHTex',
    width: W / 2,
    height: H / 2,
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear
  })
  this._frameBloomHTex.sizeScale = 0.5

  this._frameBloomVTex = ctx.texture2D({
    name: 'frameBloomVTex',
    width: W / 2,
    height: H / 2,
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear
  })
  this._frameBloomVTex.sizeScale = 0.5

  // SMAA
  this._frameSMAATex = ctx.texture2D({
    name: 'frameSMAATex',
    width: W,
    height: H,
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear,
    min: ctx.Filter.Linear,
    mag: ctx.Filter.Linear,
  })
  this._frameSMAAColorEdgesTex = ctx.texture2D({
    name: 'frameSMAAColorEdgesTex',
    width: W,
    height: H,
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear,
    min: ctx.Filter.Linear,
    mag: ctx.Filter.Linear,
  })
  this._frameSMAAWeightsTex = ctx.texture2D({
    name: 'frameSMAAWeightsTex',
    width: W,
    height: H,
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear,
    min: ctx.Filter.Linear,
    mag: ctx.Filter.Linear,
  })

  // Extra textures
  this._SMAASearchTex = ctx.texture2D({
    name: 'SMAASearchTex',
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear
  })
  this._SMAAAreaTex = ctx.texture2D({
    name: 'SMAAAreaTex',
    pixelFormat: this.rgbm ? ctx.PixelFormat.RGBA8 : ctx.PixelFormat.RGBA16F,
    encoding: this.rgbm ? ctx.Encoding.RGBM : ctx.Encoding.Linear,
    min: ctx.Filter.Linear
  })
  const smaaSearchImage = new Image()
  smaaSearchImage.src =  SMAA_TEXTURES.search
  smaaSearchImage.onload = () => {
    this.ctx.update(this._SMAASearchTex, {
      data: smaaSearchImage,
      width: smaaSearchImage.width,
      height: smaaSearchImage.height
    })
  }
  const smaaAreaImage = new Image()
  smaaAreaImage.src =  SMAA_TEXTURES.area
  smaaAreaImage.onload = () => {
    this.ctx.update(this._SMAAAreaTex, {
      data: smaaAreaImage,
      width: smaaAreaImage.width,
      height: smaaAreaImage.height
    })
  }

  this._textures = [
    this._frameColorTex,
    this._frameEmissiveTex,
    this._frameNormalTex,
    this._frameDepthTex,
    this._frameAOTex,
    this._frameAOBlurTex,
    this._frameDofBlurTex,
    this._frameBloomHTex,
    this._frameBloomVTex,
    this._frameSMAATex,
    this._frameSMAAColorEdgesTex,
    this._frameSMAAWeightsTex
  ]

  ctx.gl.getExtension('OES_texture_float ')
  this._ssaoKernelMap = ctx.texture2D({ width: 8, height: 8, data: ssaoKernelData, pixelFormat: ctx.PixelFormat.RGBA32F, encoding: ctx.Encoding.Linear, wrap: ctx.Wrap.Repeat })
  this._ssaoNoiseMap = ctx.texture2D({ width: 128, height: 128, data: ssaoNoiseData, pixelFormat: ctx.PixelFormat.RGBA32F, encoding: ctx.Encoding.Linear, wrap: ctx.Wrap.Repeat, mag: ctx.Filter.Linear, min: ctx.Filter.Linear })

  this._drawFrameNormalsFboCommand = {
    name: 'Camera.drawFrameNormals',
    pass: ctx.pass({
      name: 'Camera.drawFrameNormals',
      color: [ this._frameNormalTex ],
      depth: this._frameDepthTex,
      clearColor: [0, 0, 0, 0],
      clearDepth: 1
    })
  }

  this._drawFrameFboCommand = {
    name: 'Camera.drawFrame',
    pass: ctx.pass({
      name: 'Camera.drawFrame',
      color: [ this._frameColorTex, this._frameEmissiveTex ],
      depth: this._frameDepthTex,
      clearColor: this.backgroundColor
    })
  }

  this._ssaoCmd = {
    name: 'Camera.ssao',
    pass: ctx.pass({
      name: 'Camera.ssao',
      color: [ this._frameAOTex ],
      clearColor: [0, 0, 0, 1]
      // clearDepth: 1
    }),
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: SAO_FRAG
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      uDepthMap: this._frameDepthTex,
      uNormalMap: this._frameNormalTex,
      uNoiseMap: this._ssaoNoiseMap
    }
  }

  this._bilateralBlurHCmd = {
    name: 'Camera.bilateralBlurH',
    pass: ctx.pass({
      name: 'Camera.bilateralBlurH',
      color: [ this._frameAOBlurTex ],
      clearColor: [1, 1, 0, 1]
    }),
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: BILATERAL_BLUR_FRAG
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      depthMap: this._frameDepthTex,
      image: this._frameAOTex,
      // direction: [State.bilateralBlurRadius, 0], // TODO:
      direction: [0.5, 0],
      uDOFDepth: 0,
      uDOFRange: 0
    }
  }

  this._bilateralBlurVCmd = {
    name: 'Camera.bilateralBlurV',
    pass: ctx.pass({
      name: 'Camera.bilateralBlurV',
      color: [ this._frameAOTex ],
      clearColor: [1, 1, 0, 1]
    }),
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: BILATERAL_BLUR_FRAG
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      depthMap: this._frameDepthTex,
      image: this._frameAOBlurTex,
      // direction: [0, State.bilateralBlurRadius], // TODO:
      direction: [0, 0.5],
      uDOFDepth: 0,
      uDOFRange: 0
    }
  }

  this._dofBlurHCmd = {
    name: 'Camera.bilateralBlurH',
    pass: ctx.pass({
      name: 'Camera.dofBilateralBlurH',
      color: [ this._frameDofBlurTex ],
      clearColor: [1, 1, 0, 1]
    }),
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: BILATERAL_BLUR_FRAG
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      depthMap: this._frameDepthTex,
      image: this._frameColorTex,
      // direction: [State.bilateralBlurRadius, 0] // TODO:
      direction: [0.5, 0]
    }
  }

  this._dofBlurVCmd = {
    name: 'Camera.bilateralBlurV',
    pass: ctx.pass({
      name: 'Camera.dofBilateralBlurV',
      color: [ this._frameColorTex ],
      clearColor: [1, 1, 0, 1]
    }),
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: BILATERAL_BLUR_FRAG
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      depthMap: this._frameDepthTex,
      image: this._frameDofBlurTex,
      // direction: [0, State.bilateralBlurRadius] // TODO:
      direction: [0, 0.5]
    }
  }

  this._thresholdCmd = {
    name: 'Camera.threshold',
    pass: ctx.pass({
      name: 'Camera.threshold',
      color: [ this._frameBloomVTex ],
      clearColor: [1, 1, 1, 1]
    }),
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: THRESHOLD_FRAG
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      image: this._frameColorTex,
      emissiveTex: this._frameEmissiveTex,
      // TODO: this should be called screenSize as it's used to calculate uv
      imageSize: [this._frameBloomVTex.width, this._frameBloomVTex.height],
    },
    viewport: [0, 0, this._frameBloomVTex.width, this._frameBloomVTex.height],
  }

  this._bloomHCmd = {
    name: 'Camera.bloomH',
    pass: ctx.pass({
      name: 'Camera.bloomH',
      color: [ this._frameBloomHTex ],
      clearColor: [1, 1, 1, 1]
    }),
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: BLOOM_FRAG
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      image: this._frameBloomVTex,
      imageSize: [this._frameBloomVTex.width, this._frameBloomVTex.height],
      direction: [0.5, 0]
    },
    viewport: [0, 0, this._frameBloomHTex.width, this._frameBloomHTex.height]
  }

  this._bloomVCmd = {
    name: 'Camera.bloomV',
    pass: ctx.pass({
      name: 'Camera.bloomV',
      color: [ this._frameBloomVTex ],
      clearColor: [1, 1, 0, 1]
    }),
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: BLOOM_FRAG
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      image: this._frameBloomHTex,
      imageSize: [this._frameBloomHTex.width, this._frameBloomHTex.height],
      direction: [0, 0.5]
    },
    viewport: [0, 0, this._frameBloomVTex.width, this._frameBloomVTex.height]
  }

  // SMAA
  this._smaaTexCmd = {
    name: 'Camera.smaaTex',
    pass: ctx.pass({
      name: 'Camera.smaaTex',
      color: [ this._frameSMAATex ],
      clearColor: [0, 0, 0, 1]
    }),
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: COPY_FRAG,
      depthTest: false,
      depthWrite: false
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      colorTex: this._frameColorTex
    }
  }

  this._smaaColorEdgesCmd = {
    name: 'Camera.smaaColorEdges',
    pass: ctx.pass({
      name: 'Camera.smaaColorEdges',
      color: [ this._frameSMAAColorEdgesTex ],
      clearColor: [0, 0, 0, 1]
    }),
    pipeline: ctx.pipeline({
      vert: EDGES_VERT,
      frag: EDGES_COLOR_FRAG,
      depthTest: false,
      depthWrite: false
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      colorTex: this._frameSMAATex,
      resolution: [this._frameSMAAColorEdgesTex.width, this._frameSMAAColorEdgesTex.height]
    }
  }

  this._smaaWeightsCmd = {
    name: 'Camera.smaaWeights',
    pass: ctx.pass({
      name: 'Camera.smaaWeights',
      color: [ this._frameSMAAWeightsTex ],
      clearColor: [0, 0, 0, 1]
    }),
    pipeline: ctx.pipeline({
      vert: SMAA_WEIGHTS_VERT,
      frag: SMAA_WEIGHTS_FRAG,
      depthTest: false,
      depthWrite: false
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      edgesTex: this._frameSMAAColorEdgesTex,
      areaTex: this._SMAAAreaTex,
      searchTex: this._SMAASearchTex,
      resolution: [this._frameSMAAWeightsTex.width, this._frameSMAAWeightsTex.height]
    }
  }

  this._smaaBlendCmd = {
    name: 'Camera.smaaBlend',
    pass: ctx.pass({
      name: 'Camera.smaaBlend',
      color: [ this._frameColorTex ],
      clearColor: [0, 0, 0, 1]
    }),
    pipeline: ctx.pipeline({
      vert: SMAA_BLEND_VERT,
      frag: SMAA_BLEND_FRAG,
      depthTest: false,
      depthWrite: false
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      colorTex: this._frameSMAATex,
      blendTex: this._frameSMAAWeightsTex,
      resolution: [this._frameColorTex.width, this._frameColorTex.height]
    }
  }

  // this._overlayProgram = ctx.program({ vert: POSTPROCESS_VERT, frag: POSTPROCESS_FRAG }) // TODO
  this._blitCmd = {
    name: 'Camera.blit',
    pipeline: ctx.pipeline({
      vert: POSTPROCESS_VERT,
      frag: POSTPROCESS_FRAG
    }),
    attributes: this._fsqMesh.attributes,
    indices: this._fsqMesh.indices,
    uniforms: {
      uOverlay: this._frameColorTex,
      uOverlayEncoding: this._frameColorTex.encoding,
      uViewMatrix: this.viewMatrix,
      depthMap: this._frameDepthTex,
      depthMapSize: [W, H],
      uBloomMap: this._frameBloomVTex,
      uEmissiveMap: this._frameEmissiveTex
    }
  }
}

Camera.prototype.update = function () {
  mat4.set(this.viewMatrix, this.entity.transform.modelMatrix)
  mat4.invert(this.viewMatrix)
}

module.exports = function createCamera (opts) {
  return new Camera(opts)
}
