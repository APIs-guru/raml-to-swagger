'use strict';

var assert = require('assert');
var YAML = require('js-yaml');
var URI = require('URIjs');
var _ = require('lodash');

exports.convert = function (data) {
  var firstLine = data.substr(0, data.indexOf('\n'));
  assert.equal(firstLine, '#%RAML 0.8');

  //convert from YAML to JSON
  var raml = YAML.safeLoad(data);

  //Don't support URI templates right now.
  assert(raml.baseUri.indexOf('{') == -1);
  assert(!('baseUriParameters' in raml));

  assert(!('protocols' in raml));
  assert(!('schemas' in raml));
  assert(!('uriParameters' in raml));

  //FIXME:
  //console.log(raml.documentation);

  var baseUri = URI(raml.baseUri);
  var swagger = {
    info: {
      title: raml.title,
      version: raml.version,
    },
    host: baseUri.host(),
    basePath: '/' + baseUri.pathname().replace(/^\/|\/$/, ''),
    schemes: [baseUri.scheme()],
    paths: parseResources(raml)
  };

  if ('mediaType' in raml) {
    swagger.consumes = [raml.mediaType];
    swagger.produces = [raml.mediaType];
  }

  return swagger;
};

function parseResources(data) {
  var srPaths = {};

  _.each(data, function (resource, resourceName) {
    if (resourceName[0] != '/')
      return;

    assert(!('displayName' in resource));
    //FIXME:
    //assert(!('description' in value));
    //assert(!('uriParameters' in resource));
    assert(!('baseUriParameters' in resource));

    var srMethods = parseMethodList(resource);
    if (!_.isEmpty(srMethods))
      srPaths[resourceName] = srMethods;

    var srSubPaths = parseResources(resource);
    _.each(srSubPaths, function (subResource, subResourceName) {
      srPaths[resourceName + subResourceName] = subResource;
    });
  });
  return srPaths;
}

function parseMethodList(data) {
  var httpMethods = ['options', 'get', 'head', 'post',
                     'put', 'delete', 'trace', 'patch'];
  var srMethods = {};
  _.each(data, function (value, key) {
    if (httpMethods.indexOf(key) === -1)
      return;
    srMethods[key] = parseMethod(value);
  });
  return srMethods;
}

function parseMethod(data) {
  assert(!('headers' in data));
  assert(!('protocols' in data));
  //assert(!('queryParameters' in data));
  //assert(!('body' in data));
  var srMethod = {
    description: data.description,
  };
  var srParameters = [];
  if (!_.isEmpty(srParameters))
    srMethod.parameters = srParameters;
  return srMethod;
}

function parseParametersList(params) {
}
