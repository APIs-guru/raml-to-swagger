'use strict';

var assert = require('assert');
var URI = require('URIjs');
var _ = require('lodash');
var jsonCompat = require('json-schema-compatibility');
var traverse = require('traverse');
var HttpStatus = require('http-status-codes').getStatusText;

exports.convert = function (raml) {

  //Don't support URI templates right now.
  assert(raml.baseUri.indexOf('{') == -1);
  assert(!('baseUriParameters' in raml));

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
    schemes: parseProtocols(raml.protocols) || [baseUri.scheme()],
    paths: parseResources(raml.resources),
    definitions: parseSchemas(raml.schemas)
  };

  if ('mediaType' in raml) {
    swagger.consumes = [raml.mediaType];
    swagger.produces = [raml.mediaType];
  }

  removeUndefined(swagger);
  return swagger;
};

function parseSchemas(ramlSchemas) {
  return _.reduce(ramlSchemas, function (definitions, ramlSchemasMap) {
    return _.assign(definitions, ramlSchemasMap, function (dummy, ramlSchema) {
      return convertSchema(ramlSchema);
    });
  }, {});
}

function parseProtocols(ramlProtocols) {
  return _.map(ramlProtocols, String.toLowerCase);
}

function parseResources(ramlResources, srPathParameters) {
  var srPaths = {};

  _.each(ramlResources, function (ramlResource) {

    assert(!('displayName' in ramlResource));
    assert(!('description' in ramlResource && ramlResource.description !== ''));
    assert(!('baseUriParameters' in ramlResource));

    var resourceName = ramlResource.relativeUri;
    assert(resourceName);

    srPathParameters = (srPathParameters || []).concat(
      parseParametersList(ramlResource.uriParameters, 'path'));

    var srMethods = parseMethodList(ramlResource.methods, srPathParameters);
    if (!_.isEmpty(srMethods))
      srPaths[resourceName] = srMethods;

    var srSubPaths = parseResources(ramlResource.resources, srPathParameters);
    _.each(srSubPaths, function (subResource, subResourceName) {
      srPaths[resourceName + subResourceName] = subResource;
    });
  });
  return srPaths;
}

function parseMethodList(ramlMethods, srPathParameters) {
  var srMethods = {};
  _.each(ramlMethods, function (ramlMethod) {
    var srMethod = parseMethod(ramlMethod);
    if (!_.isEmpty(srPathParameters))
      srMethod.parameters = srPathParameters.concat(srMethod.parameters);
    srMethods[ramlMethod.method] = srMethod;
  });
  return srMethods;
}

function parseMethod(ramlMethod) {
  //FIXME:
  //assert(!('protocols' in data));
  //assert(!('securedBy' in data));

  //assert(_.has(data, 'responses'));

  var srMethod = {
    description: ramlMethod.description,
  };

  var srParameters = parseParametersList(ramlMethod.queryParameters, 'query');
  srParameters = srParameters.concat(
    parseParametersList(ramlMethod.headers, 'header'));

  if (!_.isEmpty(srParameters))
    srMethod.parameters = srParameters;

  //parseBody(data, srMethod);
  srMethod.responses = parseResponses(ramlMethod.responses);
  return srMethod;
}

function parseResponses(ramlResponces) {
  if (_.isEmpty(ramlResponces)) {
    return {
      200: { description: HttpStatus(200) }
    };
  }

  var srResponses = {};
  _.each(ramlResponces, function (ramlResponce, httpCode) {
    var defaultDescription = HttpStatus(parseInt(httpCode));
    srResponses[httpCode] = {
      description: ramlResponce.description || defaultDescription
    };

    if (!_.has(ramlResponce, 'body'))
      return;

    //if (!_.has(value.body, 'schema')) {
    //  console.log(_.keys(value.body));
    //}

  });
  return srResponses;
}

function parseParametersList(params, inValue) {
  assert(_.isUndefined(params) || _.isPlainObject(params));

  return _.map(params, function (value, key) {
     assert(!_.has(value, 'repeat'));
     //FIXME:
     //assert(!_.has(value, 'example'));
     assert(_.has(value, 'type') &&
       ['string', 'number', 'integer', 'boolean'].indexOf(value.type) !== -1);

     return {
       name: value.displayName || key,
       in: inValue,
       description: value.description,
       required: value.required,
       type: value.type,
       enum: value.enum,
       default: value.default,
       maximum: value.maximum,
       minimum: value.minimum,
       maxLength: value.maxLength,
       minLength: value.minLength,
       pattern: value.pattern
     };
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

  return convertSchema(data.schema);
}

function convertSchema(schema) {
  if (_.isUndefined(schema))
    return;

  assert(_.isString(schema));

  var schema = JSON.parse(schema);

  //FIXME:
  assert.equal(schema.$schema, 'http://json-schema.org/draft-03/schema');

  schema = jsonCompat.v4(schema);
  delete schema.$schema;
  return schema;
}

function removeUndefined(obj) {
  traverse(obj).forEach(function (value) {
    if (value === undefined)
      this.remove();
  });
}
