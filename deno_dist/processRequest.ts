import {
  execute as defaultExecute,
  getOperationAST,
  parse as defaultParse,
  subscribe as defaultSubscribe,
  validate as defaultValidate,
  DocumentNode,
  GraphQLError,
  GraphQLSchema,
  OperationDefinitionNode,
  ValidationRule,
} from "https://cdn.skypack.dev/graphql@15.4.0-experimental-stream-defer.1?dts";
import { stopAsyncIteration, isAsyncIterable, isHttpMethod } from "./util/index.ts";
import { HttpError } from "./errors.ts";
import { ProcessRequestOptions, ProcessRequestResult } from "./types.ts";

const parseQuery = (
  query: string | DocumentNode,
  parse: typeof defaultParse
): DocumentNode => {
  if (typeof query !== "string" && query.kind === "Document") {
    return query;
  }
  try {
    return parse(query as string);
  } catch (syntaxError) {
    throw new HttpError(400, "GraphQL syntax error.", {
      graphqlErrors: [syntaxError],
    });
  }
};

export const validateDocument = (
  schema: GraphQLSchema,
  document: DocumentNode,
  validate: typeof defaultValidate,
  validationRules?: readonly ValidationRule[]
): void => {
  const validationErrors = validate(schema, document, validationRules);
  if (validationErrors.length) {
    throw new HttpError(400, "GraphQL validation error.", {
      graphqlErrors: validationErrors,
    });
  }
};

const getExecutableOperation = (
  document: DocumentNode,
  operationName?: string
): OperationDefinitionNode => {
  const operation = getOperationAST(document, operationName);

  if (!operation) {
    throw new HttpError(400, "Could not determine what operation to execute.");
  }

  return operation;
};

export const processRequest = async (
  options: ProcessRequestOptions
): Promise<ProcessRequestResult> => {
  const {
    contextFactory,
    execute = defaultExecute,
    operationName,
    parse = defaultParse,
    query,
    request,
    rootValueFactory,
    schema,
    subscribe = defaultSubscribe,
    validate = defaultValidate,
    validationRules,
    variables,
  } = options;

  try {
    if (
      !isHttpMethod("GET", request.method) &&
      !isHttpMethod("POST", request.method)
    ) {
      throw new HttpError(405, "GraphQL only supports GET and POST requests.", {
        headers: [{ name: "Allow", value: "GET, POST" }],
      });
    }

    if (query == null) {
      throw new HttpError(400, "Must provide query string.");
    }

    const document = parseQuery(query, parse);

    validateDocument(schema, document, validate, validationRules);

    const operation = getExecutableOperation(document, operationName);

    if (
      operation.operation === "mutation" &&
      isHttpMethod("GET", request.method)
    ) {
      throw new HttpError(
        405,
        "Can only perform a mutation operation from a POST request.",
        { headers: [{ name: "Allow", value: "POST" }] }
      );
    }

    let variableValues: { [name: string]: any } | undefined;

    try {
      if (variables) {
        variableValues =
          typeof variables === "string" ? JSON.parse(variables) : variables;
      }
    } catch (_error) {
      throw new HttpError(400, "Variables are invalid JSON.");
    }

    try {
      const executionContext = {
        document,
        operation,
        variables: variableValues,
      };
      const contextValue = contextFactory
        ? await contextFactory(executionContext)
        : {};
      const rootValue = rootValueFactory
        ? await rootValueFactory(executionContext)
        : {};

      if (operation.operation === "subscription") {
        const result = await subscribe(
          schema,
          document,
          rootValue,
          contextValue,
          variableValues,
          operationName
        );

        // If errors are encountered while subscribing to the operation, an execution result
        // instead of an AsyncIterable. We only return a PUSH object if we have an AsyncIterable.
        if (isAsyncIterable(result)) {
          return {
            type: "PUSH",
            subscribe: async (onResult) => {
              for await (const executionResult of result) {
                onResult(executionResult);
              }
            },
            unsubscribe: () => {
              stopAsyncIteration(result);
            },
          };
        } else {
          return {
            type: "RESPONSE",
            payload: result,
            status: 200,
            headers: [],
          };
        }
      } else {
        const result = await execute(
          schema,
          document,
          rootValue,
          contextValue,
          variableValues,
          operationName
        );

        // Operations that use @defer and @stream will return an `AsyncIterable` instead of an
        // execution result.
        if (isAsyncIterable(result)) {
          return {
            type: "MULTIPART_RESPONSE",
            subscribe: async (onResult) => {
              for await (const payload of result) {
                onResult(payload);
              }
            },
            unsubscribe: () => {
              stopAsyncIteration(result);
            },
          };
        } else {
          return {
            type: "RESPONSE",
            status: 200,
            headers: [],
            payload: result,
          };
        }
      }
    } catch (executionError) {
      throw new HttpError(
        500,
        "Unexpected error encountered while executing GraphQL request.",
        {
          graphqlErrors: [new GraphQLError(executionError.message)],
        }
      );
    }
  } catch (error) {
    return {
      type: "RESPONSE",
      status: error.status || 500,
      headers: error.headers || [],
      payload: {
        data: null,
        errors: error.graphqlErrors || [new GraphQLError(error.message)],
      },
    };
  }
};
