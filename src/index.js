'use strict';

var assert = require('assert');
var URI = require('urijs');
var _ = require('lodash');
var jsonCompat = require('json-schema-compatibility');
var HttpStatus = require('http-status-codes').getStatusText;
var jp = require('jsonpath');

exports.convert = function (raml) {
  var baseUri = raml.baseUri;

  //
  baseUri = baseUri.replace(/{version}/g, raml.version);
  //Don't support other URI templates right now.
  assert(baseUri.indexOf('{') == -1);

  baseUri = URI(raml.baseUri);

  assert(!('baseUriParameters' in raml) ||
    _.isEqual(_.keys(raml.baseUriParameters), ['version']));
  assert(!('uriParameters' in raml));

  //FIXME:
  //console.log(raml.documentation);

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

  jp.apply(swagger.paths, '$..*.schema' , function (schema) {
    var result = schema;
    _.each(swagger.definitions, function (definition, name) {
      if (!_.isEqual(schema, definition))
        return;
      result = { $ref: '#/definitions/' + name};
    });
    return result;
  });

  if ('mediaType' in raml) {
    swagger.consumes = [raml.mediaType];
    swagger.produces = [raml.mediaType];
  }

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
  return _.map(ramlProtocols, function (str) {
    return str.toLowerCase();
  });
}

function parseResources(ramlResources, srPathParameters) {
  var srPaths = {};

  _.each(ramlResources, function (ramlResource) {

    //assert(!('displayName' in ramlResource));
    assert(!('description' in ramlResource && ramlResource.description !== ''));
    assert(!('baseUriParameters' in ramlResource));

    var resourceName = ramlResource.relativeUri;
    assert(resourceName);

    var srResourceParameters = (srPathParameters || []).concat(
      parseParametersList(ramlResource.uriParameters, 'path'));

    var srMethods = parseMethodList(ramlResource.methods, srResourceParameters);
    if (!_.isEmpty(srMethods))
      srPaths[resourceName] = srMethods;

    var srSubPaths = parseResources(ramlResource.resources, srResourceParameters);
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

  parseBody(ramlMethod.body, srMethod);

  parseResponses(ramlMethod, srMethod);

  return srMethod;
}

function parseResponses(ramlMethod, srMethod) {
  var ramlResponces = ramlMethod.responses;
  if (_.isEmpty(ramlResponces)) {
    return {
      200: { description: HttpStatus(200) }
    };
  }

  srMethod.responses = {};
  _.each(ramlResponces, function (ramlResponce, httpCode) {
    var defaultDescription = HttpStatus(parseInt(httpCode));
    var srResponse = srMethod.responses[httpCode] = {
      description: _.get(ramlResponce, 'description') || defaultDescription
    };

    if (!_.has(ramlResponce, 'body'))
      return;

    var jsonMIME = 'application/json';
    var produces = _.without(_.keys(ramlResponce.body), jsonMIME);
    //TODO: types could have examples.
    if (!_.isEmpty(produces))
      srMethod.produces = produces;

    var jsonSchema = _.get(ramlResponce.body, jsonMIME);
    if (!_.isUndefined(jsonSchema)) {
      assert(!_.has(jsonSchema, 'example'));
      srResponse.schema = parseJsonPayload(jsonSchema);
    }
  });
}

function parseParametersList(params, inValue) {
  assert(_.isUndefined(params) || _.isPlainObject(params));

  return _.map(params, function (value, key) {
     assert(!_.has(value, 'repeat'));
     //FIXME:
     //assert(!_.has(value, 'example'));
     //assert(!_.has(value, 'displayName'));
     assert(_.has(value, 'type') &&
       ['string', 'number', 'integer', 'boolean'].indexOf(value.type) !== -1);

     //
     return {
       name: key,
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

function parseBody(ramlBody, srMethod) {
  if (!ramlBody)
    return;

  var keys = _.keys(ramlBody)
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

  if (_.isUndefined(srMethod.parameters))
    srMethod.parameters = [];

  srMethod.parameters.push({
    //FIXME: check if name is used;
    name: 'body',
    in: 'body',
    required: true,
    //TODO: copy example
    schema: parseJsonPayload(ramlBody[jsonMIME])
  });
}

function parseJsonPayload(data)
{
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
