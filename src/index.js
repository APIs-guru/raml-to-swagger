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

  var swagger = {
    swagger: '2.0',
    info: {
      title: raml.title,
      version: raml.version,
    },
    securityDefinitions: parseSecuritySchemes(raml.securitySchemes),
    paths: parseResources(raml.resources),
    definitions: parseSchemas(raml.schemas)
  };

  parseBaseUri(raml, swagger);

  jp.apply(swagger.paths, '$..*.schema' , function (schema) {
    if (!schema || _.isEmpty(schema))
      return;

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

  //TODO: refactor into function
  //Fix incorrect arrays in RAML
  //TODO: add description
  _.each(swagger.definitions, function (schema, name) {
    if (!schema || schema.type !== 'array' || !_.isUndefined(schema.items))
      return;

    if (_.isArray(schema[name]) && _.isPlainObject(schema[name][0])) {
      schema.items = schema[name][0];
      delete schema[name];
    }
  });

  return swagger;
};

function parseBaseUri(raml, swagger) {
  var baseUri = raml.baseUri;

  if (!baseUri)
    return;

  var baseUriParameters = _.omit(raml.baseUriParameters, 'version');
  baseUri = baseUri.replace(/{version}/g, raml.version);
  baseUri = URI(baseUri);

  // Split out part path segments starting from first template param
  var match = /^(.*?)(\/[^\/]*?{.*)?$/.exec(baseUri.path());
  baseUri.path(match[1]);
  var pathPrefix = match[2];

  //Don't support other URI templates right now.
  assert(baseUri.href().indexOf('{') == -1);
  assert(!('uriParameters' in raml));

  _.assign(swagger, {
    host: baseUri.host(),
    basePath: '/' + baseUri.pathname().replace(/^\/|\/$/, ''),
    schemes: parseProtocols(raml.protocols) || [baseUri.scheme()]
  });

  if (!pathPrefix)
    return;

  pathPrefix = pathPrefix.replace(/\/$/, '');
  baseUriParameters = parseParametersList(baseUriParameters);
  swagger.paths = _.mapKeys(swagger.paths, function (value, key) {
    value.parameters = _.concat(baseUriParameters, value.parameters);
    return pathPrefix + key;
  });
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
    return _.assignWith(definitions, ramlSchemasMap, function (dummy, ramlSchema) {
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

    //FIXME: convert or create warning
    //assert(!('displayName' in ramlResource));
    //assert(!('description' in ramlResource && ramlResource.description !== ''));
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
      srResponse.schema = convertSchema(_.get(jsonSchema, 'schema'));
    }
  });
}

function parseParametersList(params, inValue) {
  assert(_.isUndefined(params) || _.isPlainObject(params));

  return _.map(params, function (value, key) {
     //FIXME:
     //assert(!_.has(value, 'example'));
     //assert(!_.has(value, 'displayName'));
     assert(_.has(value, 'type') &&
       ['date', 'string', 'number', 'integer', 'boolean'].indexOf(value.type) !== -1);

     var srParameter = {
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

     if (value.repeat === true) {
       assert(['query', 'formData'].indexOf(inValue) !== -1);
       srParameter = {
         type: 'array',
         items: srParameter,
         collectionFormat: 'multi'
       }
     }

     _.assign(srParameter, {
       name: key,
       in: inValue,
       description: value.description,
       required: value.required
     });

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
    schema: convertSchema(_.get(ramlBody[jsonMIME], 'schema'))
  });
}

function convertSchema(schema) {
  if (_.isUndefined(schema))
    return;

  assert(_.isString(schema));

  try {
    var schema = JSON.parse(schema);
  }
  catch (e) {
    return undefined;
  }

  delete schema.id;
  delete schema.$schema;
  delete schema[''];

  //Convertion is safe even for Draft4 schemas, so convert everything
  schema = jsonCompat.v4(schema);

  //Add '#/definitions/' prefix to all internal refs
  jp.apply(schema, '$..*["$ref"]' , function (ref) {
    return '#/definitions/' + ref;
  });

  //Fixes for common mistakes in RAML 0.8

  // Fix case where 'list' keyword used instead of 'items':
  // {
  //   "type": "array",
  //   "list": [{
  //     ...
  //   ]}
  // }
  if (schema.type === 'array' && !_.isUndefined(schema.list)) {
    assert(_.isUndefined(schema.items));
    assert(_.size(schema.list) === 1);
    assert(_.isPlainObject(schema.list[0]));
    schema.items = schema.list[0];
    delete schema.list;
  }

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
  // Or simular case for arrays, when same wrapper used instead of 'items'.
  _.each(jp.nodes(schema, '$..*[""]'), function(result) {
    var value = result.value;
    var path = result.path;

    if (!_.isArray(value) || _.size(value) !== 1 || !_.isPlainObject(value[0]))
      return;

    path = _.dropRight(path);
    var parent = jp.value(schema, jp.stringify(path));
    delete parent[''];

    if (_.isEmpty(parent) && ['properties', 'items'].indexOf(_.last(path)) !== -1) {
      parent = jp.value(schema, jp.stringify(_.dropRight(path)));
      delete parent.properties;
    }

    switch (parent.type) {
      case 'object':
        parent.additionalProperties = value[0];
        break;
      case 'array':
        parent.items = value[0];
        break;
      default:
        assert(false);
    }
  });

  // Fix case when arrays definition wrapped with array, like that:
  // [{
  //   "type": "array",
  //   ...
  // }]
  jp.apply(schema, '$..properties[?(@.length === 1 && @[0].type === "array")]', function(schema) {
    return schema[0];
  });

  // Fix incorrect array properties, like that:
  // {
  //   "properties": {
  //     "type": array,
  //     "<name>": [{
  //       ...
  //     }]
  //   }
  // }
  _.each(jp.nodes(schema, '$..properties[?(@.length === 1)]'), function(result) {
    var name = _.last(result.path);
    var parent = jp.value(schema, jp.stringify(_.dropRight(result.path)));

    if (parent['type'] === 'array') {
      parent[name] = {type: 'array', items: result.value[0]}
      delete parent['type'];
    }
  });

  // Fix case then 'items' value is empty or single element array.
  function unwrapItems(schema) {
    if (_.isEmpty(schema.items))
      schema.items = {};
    else {
      assert(_.isPlainObject(schema.items[0]));
      schema.items = schema.items[0];
    }

    return schema;
  }

  jp.apply(schema, '$..*[?(@.type === "array" && @.items && @.items.length <= 1)]', unwrapItems);
  //JSON Path can't apply to root object so do this manually
  if (schema.type === 'array' && _.isArray(schema.items) && _.size(schema.items) <= 1)
    unwrapItems(schema);

  return schema;
}
