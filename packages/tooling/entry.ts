/**
 * Whether this module is the file Node was asked to run.
 *
 * Every script here exports its work as functions and runs it only behind this
 * check, so that importing one from a test costs nothing. `require.main` has no
 * ESM equivalent, and comparing raw paths is wrong the moment one side is a
 * file URL and the other is not, so both sides are normalised to a URL.
 */
import { pathToFileURL } from 'node:url';

export const isEntry = (moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean =>
  argv1 !== undefined && argv1 !== '' && pathToFileURL(argv1).href === moduleUrl;
