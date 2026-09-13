'use ipc:main';

let calls = 0;

export async function add(left: number, right: number) {
  calls++;

  return { answer: left + right, calls };
}
