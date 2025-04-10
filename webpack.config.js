// webpack.config.js
const nodeExternals = require('webpack-node-externals');
const TerserPlugin = require('terser-webpack-plugin');
const ShebangPlugin = require('webpack-shebang-plugin');

module.exports = {
    target: 'node',
    entry: {
        index: './src/index.ts',
    },
    mode: 'production',
    module: {
        rules: [
            {
                test: /\.(js|ts)$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [
                            [
                                '@babel/preset-env',
                                {
                                    targets: { node: '18' },
                                },
                            ],
                            '@babel/preset-typescript',
                        ],
                        plugins: [
                            '@babel/plugin-syntax-top-level-await',
                            '@babel/plugin-proposal-optional-chaining',
                            '@babel/plugin-proposal-nullish-coalescing-operator',
                        ],
                    },
                },
            },
            { test: /\.ya?ml$/, loader: 'yaml-loader' },
        ],
    },
    plugins: [
        new ShebangPlugin()
    ],
    resolve: {
        extensions: ['.ts', '.js', '.json', '.yaml', '.yml'],
    },
    optimization: {
        minimize: true,
        minimizer: [new TerserPlugin()],
    },
    devtool: 'source-map',
    externals: [
        ({ context, request }, callback) => {
            // 对特定模块使用 require 方式
            if (request.includes('@serverless-devs/load-component')) {
                return callback(null, `commonjs ${request}`);
            }
            // 其他模块走 nodeExternals
            nodeExternals({ allowlist: [/.*/] })(context, request, callback);
        }
    ],
    experiments: {
        topLevelAwait: true,
    },
    output: {
        libraryTarget: 'commonjs2'
    },

};
