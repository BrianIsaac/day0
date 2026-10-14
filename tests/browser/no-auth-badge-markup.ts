import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoAuthBadge } from '../../app/NoAuthBadge';

/**
 * Print the no-auth install's header badge as markup, for the browser job to mount in the
 * header's account cluster under the build's stylesheet: the job's build is not a no-auth one, so
 * the badge is rendered from the component. It runs under `tsx` in its own process, as
 * `tab-strip-markup.ts` does.
 */
process.stdout.write(renderToStaticMarkup(createElement(NoAuthBadge)));
