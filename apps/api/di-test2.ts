import 'reflect-metadata';
import { register } from '@swc-node/register/esm-register';
class A {}
class B { constructor(private a: A) {} }
console.log('paramtypes:', Reflect.getMetadata('design:paramtypes', B));
