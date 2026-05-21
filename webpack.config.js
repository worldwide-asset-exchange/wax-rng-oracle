const path = require('path');
const webpack = require('webpack');
const htmlWebpackPlugin = require('html-webpack-plugin');

module.exports =  {
  devtools: 'eval-source-map',
  entry: [
    'webpack-hot-middleware/client',
    path.join(__dirname, '/ui/js/app.react.js')
  ],
  output: {
    path: path.resolve(__dirname, 'public'),
    filename: 'bundle.js'
  },
  plugins: [
    new webpack.NoErrorsPlugin(),
    new webpack.optimize.OccurenceOrderPlugin(),
    new webpack.HotModuleReplacementPlugin(),
    new htmlWebpackPlugin({
      filename: 'index.html',
      template: './ui/index.html',
    })
  ],
  module: {
    loaders: [
      {
        test: /\.js$/,
        include: [
          path.join(__dirname, 'ui'),
          path.join(__dirname, 'server/shared')
        ],
        loaders: [ 'react-hot', 'babel' ]
      }
    ]
  },
  resolve: {
    extentions: [ '', '.js' ]
  }
}