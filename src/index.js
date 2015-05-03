'use strict';

var assert = require('assert');
var YAML = require('js-yaml');
var URI = require('URIjs');
var _ = require('lodash');
var jsonCompat = require('json-schema-compatibility');
var traverse = require('traverse');
var HttpStatus = require('http-status-codes').getStatusText;

exports.convert = function (data) {
  var firstLine = data.substr(0, data.indexOf('\n'));
  assert.equal(firstLine, '#%RAML 0.8');

  //convert from YAML to JSON
  var raml = YAML.safeLoad(data);

  checkIncludes(raml);
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
    swagger: '2.0',
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

  removeUndefined(swagger);
  return swagger;
};

function checkIncludes(obj) {
  traverse(obj).forEach(function (value) {
    assert(!_.startsWith(value, '!include'));
  });
}

function parseResources(data) {
  var srPaths = {};

  _.each(data, function (resource, resourceName) {
    if (resourceName[0] != '/')
      return;

    assert(!('displayName' in resource));
    //FIXME:
    //assert(!('description' in value));
    assert(!('baseUriParameters' in resource));

    var srParameters = parseParametersList(resource.uriParameters, 'path');

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

  //assert(_.has(data, 'responses'));

  var srMethod = {
    description: data.description,
  };

  var srParameters = [];

  if (_.has(data, 'queryParameters'))
    _.extend(srParameters, parseParametersList(data.queryParameters, 'query'));

  if (!_.isEmpty(srParameters))
    srMethod.parameters = srParameters;

  parseBody(data, srMethod);
  srMethod.responses = parseResponses(data.responses);
  return srMethod;
}

function parseResponses(data) {
  if (_.isEmpty(data)) {
    return {
      200: { description: HttpStatus(200) }
    };
  }

  var srResponses = {};
  _.each(data, function (value, key) {
    srResponses[key] = {
      description: value.description || HttpStatus(parseInt(key))
    };

    if (!_.has(value, 'body'))
      return;

    if (!_.has(value.body, 'schema')) {
      console.log(_.keys(value.body));
    }

  });
  return srResponses;
}

function parseParametersList(params, inValue) {
  var srParams = [];

  _.each(params, function (value, key) {
     assert(!_.has(value, 'displayName'));
     assert(!_.has(value, 'repeat'));
     assert(!_.has(value, 'example'));
     assert(!_.has(value, 'type') ||
       ['string', 'number', 'integer', 'boolean'].indexOf(value.type) !== -1);
     assert(_.isObject(value));

     srParams.push({
       name: key,
       in: inValue,
       description: value.description,
       required: value.required,
       type: value.type || 'string',
       enum: value.enum,
       default: value.default,
       maximum: value.maximum,
       minimum: value.minimum,
       maxLength: value.maxLength,
       minLength: value.minLength,
       pattern: value.pattern
     });
  });
}

function parseBody(data, srMethod) {
  if (!_.has(data, 'body'))
    return;

  data = data.body;
  var keys = _.keys(data)
  assert(!_.has(keys, 'application/x-www-form-urlencoded'));
  assert(!_.has(keys, 'multipart/form-data'));
  //TODO: All parsers of RAML MUST be able to interpret ... and XML Schema
  var jsonMIME = 'application/json';

  var consumes = _.without(keys, jsonMIME);
  //TODO: types could have examples.
  if (!_.isEmpty(consumes))
    srMethod.consumes = consumes;

  if (_.indexOf(keys, jsonMIME) === -1)
    return;

  assert(_.isEmpty(consumes));//No alternatives to JSON

  if (_.isUndefined(srMethod.parameters))
    srMethod.parameters = [];

  srMethod.parameters.push({
    //FIXME: check if name is used;
    name: 'body',
    in: 'body',
    required: true,
    schema: parseJsonPayload(data[jsonMIME])
  });
}

function parseJsonPayload(data)
{
  assert(!_.has(data, 'example'));
  assert(_.has(data, 'schema'));
  assert(!_.startsWith(data.schema, '!include'));
  var schema = JSON.parse(data.schema);

  //FIXME:
  assert.equal(schema.$schema, 'http://json-schema.org/draft-03/schema');

  schema = jsonCompat.v4(schema);
  //FIXME:
  delete schema.$schema;
  return schema;
}

function removeUndefined(obj) {
  traverse(obj).forEach(function (value) {
    if (value === undefined)
      this.remove();
  });
}
