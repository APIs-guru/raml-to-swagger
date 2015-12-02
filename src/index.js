'use strict';

var assert = require('assert');
var URI = require('urijs');
var _ = require('lodash');
var jsonCompat = require('json-schema-compatibility');
var HttpStatus = require('http-status-codes').getStatusText;
var jp = require('jsonpath');

exports.convert = function (raml) {
  //FIXME:
  //console.log(raml.documentation);

  var swagger = _.assign({
    swagger: '2.0',
    info: {
      title: raml.title,
      version: raml.version,
    },
    securityDefinitions: parseSecuritySchemes(raml.securitySchemes),
    paths: parseResources(raml.resources),
    definitions: parseSchemas(raml.schemas)
  }, parseBaseUri(raml));

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

function parseBaseUri(raml) {
  var baseUri = raml.baseUri;

  if (!baseUri)
    return {};

  baseUri = baseUri.replace(/{version}/g, raml.version);
  //Don't support other URI templates right now.
  assert(baseUri.indexOf('{') == -1);

  baseUri = URI(baseUri);

  assert(!('baseUriParameters' in raml) ||
    _.isEqual(_.keys(raml.baseUriParameters), ['version']));
  assert(!('uriParameters' in raml));

  return {
    host: baseUri.host(),
    basePath: '/' + baseUri.pathname().replace(/^\/|\/$/, ''),
    schemes: parseProtocols(raml.protocols) || [baseUri.scheme()]
  };
}

function parseSecuritySchemes(ramlSecuritySchemes) {
  var srSecurityDefinitions = {};

  _.each(ramlSecuritySchemes, function (ramlSecurityArray) {
    _.each(ramlSecurityArray, function (ramlSecurityObj, name) {
      assert(ramlSecurityObj.type);

      //Swagger 2.0 doesn't support Oauth 1.0 so just skip it.
      //FIXME: add warning
      if (ramlSecurityObj.type === 'OAuth 1.0')
        return;

      var srType = {
        'OAuth 2.0': 'oauth2',
        'Basic Authentication': 'basic',
      }[ramlSecurityObj.type];
      assert(srType);

      var srSecurity = {
        type: srType,
        description: ramlSecurityObj.description,
      };

      if (srType !== 'oauth2') {
        srSecurityDefinitions[name] = srSecurity;
        return;
      }

      var ramlSettings = ramlSecurityObj.settings;
      _.assign(srSecurity, {
        authorizationUrl: ramlSettings.authorizationUri,
        tokenUrl: ramlSettings.accessTokenUri,
        scopes: _.transform(ramlSettings.scopes, function (result, name) {
          result[name] = '';
        }, {})
      });

      var ramlFlows = ramlSettings.authorizationGrants;
      _.each(ramlFlows, function (ramlFlow) {
         var srFlowSecurity = _.clone(srSecurity);
         var srFlow = srFlowSecurity.flow = {
           'code': 'accessCode',
           'token': 'implicit',
           'owner': 'password',
           'credentials': 'application'
         }[ramlFlow];

         if (srFlow === 'password' || srFlow === 'application')
           delete srFlowSecurity.authorizationUrl;

         if (srFlow === 'implicit')
           delete srFlowSecurity.tokenUrl;

         var fullName = name;
         if (_.size(ramlFlows) > 1)
           fullName = name + '_' + srFlowSecurity.flow;

         srSecurityDefinitions[fullName] = srFlowSecurity;
      });
    });
  });
  return srSecurityDefinitions;
}

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
      //TODO:
      //assert(!_.has(jsonSchema, 'example'));
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
       ['date', 'string', 'number', 'integer', 'boolean'].indexOf(value.type) !== -1);

     var srParameter = {
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

     if (srParameter.type === 'date') {
       srParameter.type = 'string';
       srParameter.format = 'date';
     }

     return srParameter;
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

  delete schema.id;

  //FIXME:
  assert.equal(schema.$schema || schema[''], 'http://json-schema.org/draft-03/schema');

  schema = jsonCompat.v4(schema);
  delete schema.$schema;
  delete schema[''];

  //Add '#/definitions/' prefix to all internal refs
  jp.apply(schema, '$..*["$ref"]' , function (ref) {
    return '#/definitions/' + ref;
  });

  //Fixes for common mistakes in RAML 0.8

  // Fix case when instead of 'additionalProperties' schema put in following wrappers:
  // {
  //   "type": "object",
  //   "": [{
  //     ...
  //   }]
  // }
  // or
  // {
  //   "type": "object",
  //   "properties": {
  //     "": [{
  //       ...
  //     }]
  //   }
  // }

  _.each(jp.nodes(schema, '$..*[""]'), function(result) {
    var value = result.value;
    var path = result.path;

    if (!_.isArray(value) || _.size(value) !== 1 || !_.isPlainObject(value[0]))
      return;

    path = _.dropRight(path);
    var parent = jp.value(schema, jp.stringify(path));
    delete parent[''];

    if (_.isEmpty(parent) && _.last(path) === 'properties') {
      parent = jp.value(schema, jp.stringify(_.dropRight(path)));
      delete parent.properties;
    }

    assert(parent.type === 'object');
    parent.additionalProperties = value[0];
  });

  // Fix case when arrays definition wrapped with array, like that:
  // [{
  //   "type": "array",
  //   ...
  // }]

  _.each(jp.nodes(schema, '$..properties.*[0]'), function(result) {
    var path = _.dropRight(result.path);
    var value = jp.value(schema, jp.stringify(path));

    if (_.size(value) !== 1 || !_.isArray(value) || value[0].type !== 'array')
      return;

    var parent = jp.value(schema, jp.stringify(_.dropRight(path)));
    parent[_.last(path)] = value[0];
  });

  // Fix case then 'items' value is empty array.
  jp.apply(schema, '$..*[?(@.type === "array" && @.items.length === 0)]', function(schema) {
    schema.items = {};
  });

  return schema;
}
