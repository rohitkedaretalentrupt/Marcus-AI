/**
 * The only user shape that may leave the server (props, JSON, client context).
 * It intentionally has no password hash or other credential fields.
 */
export interface PublicUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}
