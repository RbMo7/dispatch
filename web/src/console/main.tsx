import { mount } from '../mount';
import { Console } from './Console';
import { Gallery } from './gallery/Gallery';

const path = window.location.pathname.replace(/\/+$/, '');

mount(path === '/console/_primitives' ? <Gallery /> : <Console />);
