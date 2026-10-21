// /learn/logout: clears the enrollment cookie and goes to the home page. The middleware lets it
// through without an enrollment, so an expired or broken cookie can always be cleared.
import { logout } from "./_gate";

export const onRequest: PagesFunction = ({ request }) => logout(request);
