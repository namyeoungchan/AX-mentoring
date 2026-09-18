export async function asyncFilter(values, predicate) {
    const result = [];
    for (let i = 0; i < values.length; i++)
        if (await predicate(values[i], i, values))
            result.push(values[i]);
    return result;
}
export async function asyncFind(values, predicate) {
    for (let i = 0; i < values.length; i++)
        if (await predicate(values[i], i, values))
            return values[i];
}
export async function asyncSome(values, predicate) {
    for (let i = 0; i < values.length; i++)
        if (await predicate(values[i], i, values))
            return true;
    return false;
}
export async function asyncEvery(values, predicate) {
    for (let i = 0; i < values.length; i++)
        if (!await predicate(values[i], i, values))
            return false;
    return true;
}
export async function asyncForEach(values, callback) {
    for (let i = 0; i < values.length; i++)
        await callback(values[i], i, values);
}
