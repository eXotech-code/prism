import faker from '@faker-js/faker';
import { cloneDeep } from 'lodash';
import { JSONSchema } from '../../types';

import * as JSONSchemaFaker from 'json-schema-faker';
import * as sampler from '@stoplight/json-schema-sampler';
import { Either, toError, tryCatch } from 'fp-ts/Either';
import { IHttpContent, IHttpOperation, IHttpParam } from '@stoplight/types';
import { pipe } from 'fp-ts/function';
import * as E from 'fp-ts/lib/Either';
import { stripWriteOnlyProperties } from '../../utils/filterRequiredProperties';

// necessary as workaround broken types in json-schema-faker
// @ts-ignore
JSONSchemaFaker.extend('faker', () => faker);

// From https://github.com/json-schema-faker/json-schema-faker/tree/develop/docs
// Using from entries since the types aren't 100% compatible
const JSON_SCHEMA_FAKER_DEFAULT_OPTIONS = Object.fromEntries([
  ['defaultInvalidTypeProduct', null],
  ['defaultRandExpMax', 10],
  ['pruneProperties', []],
  ['ignoreProperties', []],
  ['ignoreMissingRefs', false],
  ['failOnInvalidTypes', true],
  ['failOnInvalidFormat', true],
  ['alwaysFakeOptionals', false],
  ['optionalsProbability', false],
  ['fixedProbabilities', false],
  ['useExamplesValue', false],
  ['useDefaultValue', false],
  ['requiredOnly', false],
  ['minItems', 0],
  ['maxItems', null],
  ['minLength', 0],
  ['maxLength', null],
  ['refDepthMin', 0],
  ['refDepthMax', 3],
  ['resolveJsonPath', false],
  ['reuseProperties', false],
  ['sortProperties', null],
  ['fillProperties', true],
  ['random', Math.random],
  ['replaceEmptyByRandomValue', false],
  ['omitNulls', false],
]);

export function resetGenerator() {
  // necessary as workaround broken types in json-schema-faker
  // @ts-ignore
  JSONSchemaFaker.option({
    ...JSON_SCHEMA_FAKER_DEFAULT_OPTIONS,
    failOnInvalidTypes: false,
    failOnInvalidFormat: false,
    alwaysFakeOptionals: true,
    optionalsProbability: 1,
    fixedProbabilities: true,
    ignoreMissingRefs: true,
  });
}

resetGenerator();

class ExtendedSourceSchemaParseError extends Error {}

class StaticStringGenerator {
	constructor() { this.val = null };
	
	assignValue(val: string) { this.val = val };
}

class IncrementalIntGenerator {
	constructor(counter = 0) { this.counter = counter };

	get val() {
		return counter++;
	}
}

class SumToNGenerator {
	constructor(n: number) { this.n = n };

	randInt(max: number) {
		return Math.round(Math.random() * max);
	}

	get val() {
		const newNumber = this.randInt(n);
		n -= newNumber;
		return newNumber;
	}
}

class ValueHolderGenerator {
	constructor(val: number) { this.val = val };
}

type Generator = StaticStringGenerator | IncrementalIntGenerator | SumToNGenerator | ValueHolderGenerator;

class GeneratorOpt {
	constructor(option: string[]) { this.option = option };

	get generator(): Generator {
		const generators = {
			"const": StaticStringGenerator,
			"incremental": IncrementalIntGenerator,
			"sum": SumToNGenerator,
			"val": ValueHolderGenerator
		}

		return generators[this.option[0]];
	}
}

/* Builds an object filled with generator options.
 * This is used later by the function that assigns generators
 * to properties. */
const buildScaffold = (source: JSONSchema): JSONValue => {
	const option = source["x-generator-opt"]?.split(" ");
	switch (source.type) {
		case "object":
			let props = {};
			for (const property in source.properties) {
				props[property] = buildScaffold(source.properties[property]);
			}
			return props;
		case "array":
			if (!option) throw ExtendedSourceSchemaParseError("Encountered array property with unspecified size.");
			const arraySize = parseInt(option[1]);
			return Array(arraySize).fill(buildScaffold(source.items));
		default:
			return option ? new GeneratorOpt(option) : null;
	}
}

type Nullable<Type> = Type | null;

class ContextShard {
	constructor(parent: Nullable<ContextShard>, currentLevel: JSONValue) {
		this.parent = parent;
		this.currentLevel = currentLevel;
	}
}

const placeGenerator = (generatorOpt: GeneratorOpt, propName: string, context: ContextShard) => {
	const generator = generatorOpt.generator;
	switch (generator) {
		case IncrementalIntGenerator: {
			const parentArray = context.parent.parent.currentLevel;
			const sharedGenerator = new generator();
			for (let i = 0; i < parentArray.length; i++) {
				parentArray[i][propName] = sharedGenerator;
			}
			break;
		}
		case ValueHolderGenerator: {
			const valueHolder = new generator(parseInt(generatorOpt.option[2]));
			const props = context.parent.currentLevel;
			const sharedGenerator = new SumToNGenerator(valueHolder.val);
			const keysToFill = Object.keys(props).filter(key => props[key].option[2].slice(1, -1) === generatorOpt.option[1]);
			for (const key of keysToFill) {
				props[key] = sharedGenerator;
			}
			props[propName] = null;
			break;
		}
		case StaticStringGenerator:
			context.parent.currentLevel[propName] = new generator();
			break;
		default:
			throw new ExtendedSourceSchemaParseError(`Encountered unhandled generator type (${generator.name}).`);
			break;
	}
}

const addGenerators = (scaffold: JSONValue, propName: string, context: ContextShard = null): JSONValue => {
	if (!context) {
		context = new ContextShard(null, scaffold);
	}

	if (Array.isArray(scaffold)) {
		for (const element of scaffold) {
			addGenerators(element, propName, new ContextShard(context, element));
		}
	} else if (scaffold instanceof GeneratorOpt) {
		placeGenerator(scaffold, propName, context);
	} else if (scaffold) {
		// This is an object.
		for (const prop in scaffold) {
			addGenerators(scaffold[prop], prop, new ContextShard(context, scaffold[prop]));
		}
	}
}

export function generate(
  resource: IHttpOperation | IHttpParam | IHttpContent,
  bundle: unknown,
  source: JSONSchema
): Either<Error, unknown> {
  const scaffold = buildScaffold(source);
  addGenerators(scaffold);

  return pipe(
    stripWriteOnlyProperties(source),
    E.fromOption(() => Error('Cannot strip writeOnly properties')),
    E.chain(updatedSource =>
      tryCatch(
        // necessary as workaround broken types in json-schema-faker
        // @ts-ignore
        () => sortSchemaAlphabetically(JSONSchemaFaker.generate({ ...cloneDeep(updatedSource), __bundled__: bundle })),
        toError
      )
    )
  );
}

//sort alphabetically by keys
export function sortSchemaAlphabetically(source: any): any {
  if (source && Array.isArray(source)) {
    for (const i of source) {
      if (typeof source[i] === 'object') {
        source[i] = sortSchemaAlphabetically(source[i]);
      }
    }
    return source;
  } else if (source && typeof source === 'object') {
    Object.keys(source).forEach((key: string) => {
      if (typeof source[key] === 'object') {
        source[key] = sortSchemaAlphabetically(source[key]);
      }
    });
    return Object.fromEntries(Object.entries(source).sort());
  }

  //just return if not array or object
  return source;
}

export function generateStatic(operation: IHttpOperation, source: JSONSchema): Either<Error, unknown> {
  return pipe(
    tryCatch(() => sampler.sample(source, { ticks: 2500 }, operation), toError),
    E.mapLeft(err => {
      if (err instanceof sampler.SchemaSizeExceededError) {
        return new SchemaTooComplexGeneratorError(operation, err);
      }
      return err;
    })
  );
}

export class GeneratorError extends Error {}

export class SchemaTooComplexGeneratorError extends GeneratorError {
  constructor(operation: IHttpOperation, public readonly cause: Error) {
    super(
      `The operation ${operation.method.toUpperCase()} ${
        operation.path
      } references a JSON Schema that is too complex to generate.`
    );
  }
}
