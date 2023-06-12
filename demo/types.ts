export class DepartmentId {
    static wrap(val: number): DepartmentId {
        return val as any;
    }

    static unwrap(val: DepartmentId): number {
        return val as any;
    }

    protected _dummy: DepartmentId[];
}

export class CarId {
    static wrap(val: number): CarId {
        return val as any;
    }

    static unwrap(val: CarId): number {
        return val as any;
    }

    protected _dummy: CarId[];
}

export class EmployeeId {
    static wrap(val: number): EmployeeId {
        return val as any;
    }

    static unwrap(val: EmployeeId): number {
        return val as any;
    }

    protected _dummy: EmployeeId[];
}

export class CustomerId {
    static wrap(val: number): CustomerId {
        return val as any;
    }

    static unwrap(val: CustomerId): number {
        return val as any;
    }

    protected _dummy: CustomerId[];
}
