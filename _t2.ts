import { userBindName } from './src/auth/ldap';
const bs = String.fromCharCode(92);
console.log(userBindName({ upnSuffix: 'ucall.co.ao' }, 'UCALL' + bs + 'julio'));
