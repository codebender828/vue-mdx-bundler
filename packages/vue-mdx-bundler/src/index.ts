import fs from 'fs'
import path from 'path'
import { StringDecoder } from 'string_decoder'
import remarkFrontmatter from 'remark-frontmatter'
import { remarkMdxFrontmatter } from 'remark-mdx-frontmatter'
import matter from 'gray-matter'
import * as esbuild from 'esbuild'
import type { Plugin, BuildOptions, Loader } from 'esbuild'
import { NodeResolvePlugin } from '@esbuild-plugins/node-resolve'
import { globalExternals } from '@fal-works/esbuild-plugin-global-externals'
import type { ModuleInfo } from '@fal-works/esbuild-plugin-global-externals'
import type { VFileCompatible, CompileOptions } from 'xdm/lib/compile'
import dirnameMessedUp from './dirname-messed-up.cjs'

import { transformAsync as babel } from '@babel/core'
const { readFile, unlink } = fs.promises

type ESBuildOptions = BuildOptions

export type BundleMDXOptions = {
  /**
   * The dependencies of the MDX code to be bundled
   *
   * @example
   * ```
   * bundleMDX(mdxString, {
   *   files: {
   *     './components.tsx': `
   *       import * as React from 'react'
   *
   *      type CounterProps = {initialCount: number, step: number}
   *
   *       function Counter({initialCount = 0, step = 1}: CounterProps) {
   *         const [count, setCount] = React.useState(initialCount)
   *         const increment = () => setCount(c => c + step)
   *         return <button onClick={increment}>{count}</button>
   *       }
   *     `
   *   },
   * })
   * ```
   */
  files?: Record<string, string>
  /**
   * This allows you to modify the built-in xdm configuration (passed to xdm.compile).
   * This can be helpful for specifying your own remarkPlugins/rehypePlugins.
   *
   * @param vfileCompatible the path and contents of the mdx file being compiled
   * @param options the default options which you are expected to modify and return
   * @returns the options to be passed to xdm.compile
   *
   * @example
   * ```
   * bundleMDX(mdxString, {
   *   xdmOptions(input, options) {
   *     // this is the recommended way to add custom remark/rehype plugins:
   *     // The syntax might look weird, but it protects you in case we add/remove
   *     // plugins in the future.
   *     options.remarkPlugins = [...(options.remarkPlugins ?? []), myRemarkPlugin]
   *     options.rehypePlugins = [...(options.rehypePlugins ?? []), myRehypePlugin]
   *
   *     return options
   *   }
   * })
   * ```
   */
  xdmOptions?: (vfileCompatible: VFileCompatible, options: CompileOptions) => CompileOptions
  /**
   * This allows you to modify the built-in esbuild configuration. This can be
   * especially helpful for specifying the compilation target.
   *
   * @example
   * ```
   * bundleMDX(mdxString, {
   *   esbuildOptions(options) {
   *     options.target = [
   *       'es2020',
   *       'chrome58',
   *       'firefox57',
   *       'safari11',
   *       'edge16',
   *       'node12',
   *     ]
   *     return options
   *   }
   * })
   * ```
   */
  esbuildOptions?: (options: ESBuildOptions) => ESBuildOptions
  /**
   * Any variables you want treated as global variables in the bundling.
   *
   * NOTE: These do not have to be technically global as you will be providing
   * their values when you use getMDXComponent, but as far as esbuild is concerned
   * it will treat these values as global variables so they will not be included
   * in the bundle.
   *
   * @example
   * ```
   * bundlMDX(mdxString, {
   *   globals: {'left-pad': 'myLeftPad'},
   * })
   *
   * // then later
   *
   * import leftPad from 'left-pad'
   *
   * const Component = getMDXComponent(result.code, {myLeftPad: leftPad})
   * ```
   */
  globals?: Record<string, string | ModuleInfo>

  /**
   * Mocks vue's resolveComponent to just return the name of component.
   *
   * when using vite-plugin-components: we know that it will handle the component imports
   * but we will be getting 'Failed to resolve component' errors
   * so we need to mock vue's resolveComponent
   *
   * @default false
   */
  mockResolveComponent?: boolean

  /**
   * The current working directory for the mdx bundle. Supplying this allows
   * esbuild to resolve paths itself instead of using `files`.
   *
   * This could be the directory the mdx content was read from or in the case
   * of off-disk content a common root directory.
   *
   * @example
   * ```
   * bundleMDX(mdxString, {
   *  cwd: '/users/you/site/mdx_root'
   * })
   * ```
   */
  cwd?: string
}

async function bundleMDX(
  mdxSource: string,
  {
    files = {},
    xdmOptions = (_vfileCompatible: VFileCompatible, options: CompileOptions) => options,
    esbuildOptions = (options: ESBuildOptions) => options,
    globals = {},
    mockResolveComponent = false,
    cwd = path.join(process.cwd(), `__mdx_bundler_fake_dir__`),
  }: BundleMDXOptions = {}
) {
  if (dirnameMessedUp && !process.env.ESBUILD_BINARY_PATH) {
    console.warn(
      `mdx-bundler warning: esbuild maybe unable to find its binary, if your build fails you'll need to set ESBUILD_BINARY_PATH. Learn more: https://github.com/kentcdodds/mdx-bundler/blob/main/README.md#nextjs-esbuild-enoent`
    )
  }
  // xdm is a native ESM, and we're running in a CJS context. This is the
  // only way to import ESM within CJS
  const [{ compile: compileMDX }, { default: xdmESBuild }] = await Promise.all([
    await import('xdm'),
    await import('xdm/esbuild.js'),
  ])
  // extract the frontmatter
  const { data: frontmatter } = matter(mdxSource)

  const entryPath = path.join(cwd, './_mdx_bundler_entry_point.mdx')

  const absoluteFiles: Record<string, string> = { [entryPath]: mdxSource }

  for (const [filepath, fileCode] of Object.entries(files)) {
    absoluteFiles[path.join(cwd, filepath)] = fileCode
  }

  const inMemoryPlugin: Plugin = {
    name: 'inMemory',
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path: filePath, importer }) => {
        if (filePath === entryPath) return { path: filePath, pluginData: { inMemory: true } }

        const modulePath = path.resolve(path.dirname(importer), filePath)

        if (modulePath in absoluteFiles) return { path: modulePath, pluginData: { inMemory: true } }

        for (const ext of ['.js', '.ts', '.jsx', '.tsx', '.json', '.mdx']) {
          const fullModulePath = `${modulePath}${ext}`
          if (fullModulePath in absoluteFiles) return { path: fullModulePath, pluginData: { inMemory: true } }
        }

        // Return an empty object so that esbuild will handle resolving the file itself.
        return {}
      })

      build.onLoad({ filter: /.*/ }, async ({ path: filePath, pluginData }) => {
        if (pluginData === undefined || !pluginData.inMemory) {
          // Return an empty object so that esbuild will load & parse the file contents itself.
          return {}
        }
        // the || .js allows people to exclude a file extension
        const fileType = (path.extname(filePath) || '.jsx').slice(1)
        const contents = absoluteFiles[filePath]

        switch (fileType) {
          // case 'vue': {
          //   // TODO: esbuild plugin vue
          //   return {
          //     contents,
          //     resolveDir: path.dirname(filePath),
          //   }
          // }
          case 'mdx': {
            const vFileCompatible: VFileCompatible = {
              path: filePath,
              contents,
            }
            const vfile = await compileMDX(
              vFileCompatible,
              xdmOptions(vFileCompatible, {
                jsx: true,
                remarkPlugins: [remarkFrontmatter, [remarkMdxFrontmatter, { name: 'frontmatter' }]],
              })
            )

            let vueJsCode = (await babel(vfile.toString(), { plugins: ['@vue/babel-plugin-jsx'] }))!.code || ''

            // vueJsCode = vueJsCode.replace(
            //   /import {[^}]+} from "vue";/,
            //   'import vue from "vue"; const {isVNode: _isVNode, createVNode: _createVNode, createTextVNode: _createTextVNode, Fragment: _Fragment} = vue'
            // )

            if (mockResolveComponent) {
              // remove resolveComponent
              vueJsCode = vueJsCode.replace(/resolveComponent as _resolveComponent,/, '')

              // mock resolveComponent
              const customResolveComponent = `function _resolveComponent(name){ return name }`

              /// add mocked Function
              vueJsCode = vueJsCode.replace(
                /export default MDXContent;/,
                `${customResolveComponent} export default MDXContent;`
              )
            }
            return { contents: vueJsCode, loader: 'jsx' } //
          }
          default: {
            let loader: Loader

            if (build.initialOptions.loader && build.initialOptions.loader[`.${fileType}`]) {
              loader = build.initialOptions.loader[`.${fileType}`]
            } else {
              // @ts-ignore
              loader = fileType
            }
            return { contents, loader }
          }
        }
      })
    },
  }

  const buildOptions = esbuildOptions({
    entryPoints: [entryPath],
    write: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    },
    plugins: [
      globalExternals({
        ...globals,
        vue: {
          varName: 'vue',
          type: 'cjs',
        },
      }),
      NodeResolvePlugin({ extensions: ['.js', '.ts', '.jsx', '.tsx'] }),
      inMemoryPlugin,
      // NOTE: the only time the xdm esbuild plugin will be used
      // is if it's not processed by our inMemory plugin which will
      // only happen for mdx files imported from node_modules.
      // This is an edge case, but it's easy enough to support so we do.
      // If someone wants to customize *this* particular xdm compilation,
      // they'll need to use the esbuildOptions function to swap this
      // for their own configured version of this plugin.
      xdmESBuild(),
    ],
    bundle: true,
    format: 'iife',
    globalName: 'Component',
    minify: true,
  })

  const bundled = await esbuild.build(buildOptions)

  if (bundled.outputFiles) {
    const decoder = new StringDecoder('utf8')

    const code = decoder.write(Buffer.from(bundled.outputFiles[0].contents))

    return {
      code: `${code};return Component.default;`,
      frontmatter,
    }
  }

  if (buildOptions.outdir && buildOptions.write) {
    const code = await readFile(path.join(buildOptions.outdir, '_mdx_bundler_entry_point.js'))

    await unlink(path.join(buildOptions.outdir, '_mdx_bundler_entry_point.js'))

    return {
      code: `${code};return Component.default;`,
      frontmatter,
    }
  }

  throw new Error(
    "You must either specify `write: false` or `write: true` and `outdir: '/path'` in your esbuild options"
  )
}

export { bundleMDX }
